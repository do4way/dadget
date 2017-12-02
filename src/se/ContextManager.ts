import * as http from 'http';
import * as URL from 'url'
import * as  AsyncLock from "async-lock"
import * as EJSON from '../util/Ejson'

import { ResourceNode, ServiceEngine, Subscriber, Proxy } from '@chip-in/resource-node'
import { TransactionRequest, TransactionObject, TransactionType } from '../db/Transaction'
import { CsnDb } from '../db/CsnDb'
import { JournalDb } from '../db/JournalDb'
import { ProxyHelper } from "../util/ProxyHelper"
import { CORE_NODE } from "../Config"

/**
 * コンテキストマネージャコンフィグレーションパラメータ
 */
export class ContextManagerConfigDef {

  /**
   * データベース名
   */
  database: string
}

class TransactionJournalSubscriber extends Subscriber {

  constructor(
    protected context: ContextManager
    , protected journalDB: JournalDb
    , protected csnDB: CsnDb) {

    super()
    context.logger.debug("TransactionJournalSubscriber is created")
  }

  onReceive(msg: string) {
    //    console.log("onReceive:", msg)
    let transaction: TransactionObject = EJSON.parse(msg)
    this.context.getLock().acquire("transaction", () => {
      // 自分がスレーブになっていれば保存
      return this.csnDB.getCurrentCsn()
        .then(csn => {
          if (csn < transaction.csn) {
            return this.csnDB.update(transaction.csn)
          }
          return Promise.resolve()
        })
        .then(() => {
          return this.journalDB.findByCsn(transaction.csn)
        })
        .then(savedTransaction => {
          if (!savedTransaction) {
            // トランザクションオブジェクトをジャーナルに追加
            return this.journalDB.insert(transaction)
          } else {
            let promise = Promise.resolve()
            if (savedTransaction.digest != transaction.digest) {
              // ダイジェストが異なる場合は更新して、それ以降でtimeがこのトランザクション以前のジャーナルを削除
              promise = promise.then(() => this.journalDB.updateAndDeleteAfter(transaction))
            }
            // マスター権を喪失している場合は再接続
            if (this.context.getMountHandle()) {
              promise = promise.then(() => this.context.connect())
            }
            return promise
          }
        })
    })
  }
}

class ContextManagementServer extends Proxy {

  constructor(
    protected context: ContextManager
    , protected journalDB: JournalDb
    , protected csnDB: CsnDb) {

    super()
    context.logger.debug("ContextManagementServer is created")
  }

  onReceive(req: http.IncomingMessage, res: http.ServerResponse): Promise<http.ServerResponse> {
    if (!req.url || !req.method) throw new Error()
    let url = URL.parse(req.url)
    if (url.pathname == null) throw new Error()
    this.context.logger.debug(url.pathname)
    let method = req.method.toUpperCase()
    this.context.logger.debug(method)
    if (method == "OPTIONS") {
      return ProxyHelper.procOption(req, res)
    } else if (url.pathname.endsWith("/exec") && method == "POST") {
      return ProxyHelper.procPost(req, res, (data) => {
        this.context.logger.debug("/exec")
        let request = EJSON.parse(data)
        return this.exec(request.csn, request.request)
      })
    } else {
      this.context.logger.debug("server command not found!:" + url.pathname)
      return ProxyHelper.procError(req, res)
    }
  }

  exec(csn: number, request: TransactionRequest): Promise<{}> {
    this.context.logger.debug(`exec ${csn}`)
    let transaction: TransactionObject
    let newCsn: number
    let updateObject: {_id?: string, csn?: number}

    // TODO マスターを取得したばかりの時は時間待ち


    // コンテキスト通番をインクリメントしてトランザクションオブジェクトを作成
    return new Promise((resolve, reject) => {
      this.context.getLock().acquire("transaction", () => {
        let _request = {...request, datetime: new Date()}
        // ジャーナルと照合して矛盾がないかチェック
        return this.journalDB.checkConsistent(csn, _request)
          .then(() => this.context.checkUniqueConstraint(csn, _request))
          .then(_ => {
            updateObject = _
            return Promise.all([this.csnDB.increment(), this.journalDB.getLastDigest()])
              .then(values => {
                newCsn = values[0]
                let lastDigest = values[1]
                transaction = Object.assign({
                  csn: newCsn
                  , beforeDigest: lastDigest
                }, _request)
                transaction.digest = TransactionObject.calcDigest(transaction);
                // トランザクションオブジェクトをジャーナルに追加
                return this.journalDB.insert(transaction)
              })
          }).then(() => {
            // トランザクションオブジェクトを配信
            return this.context.getNode().publish(
              CORE_NODE.PATH_TRANSACTION.replace(/:database\b/g, this.context.getDatabase())
              , EJSON.stringify(transaction))
          })
      }).then(() => {
        if(!updateObject._id) updateObject._id = transaction.target
        updateObject.csn = newCsn
        resolve({
          status: "OK",
          updateObject: updateObject
        })
      }, reason => {
        // トランザクションエラー
        if (reason instanceof Error) {
          resolve({
            status: "NG",
            reason: reason.message
          })
        } else {
          resolve({
            status: "NG",
            reason: "unexpected"
          })
        }
      })
    })
  }
}

/**
 * コンテキストマネージャ(ContextManager)
 * 
 * コンテキストマネージャは、逆接続プロキシの Rest API で exec メソッドを提供する。
 */
export class ContextManager extends ServiceEngine {

  private option: ContextManagerConfigDef
  private node: ResourceNode
  private database: string
  private journalDb: JournalDb
  private csnDb: CsnDb
  private subscriber: TransactionJournalSubscriber
  private server: ContextManagementServer
  private mountHandle?: string
  private lock: AsyncLock

  constructor(option: ContextManagerConfigDef) {
    super(option)
    this.logger.debug(JSON.stringify(option))
    this.option = option
    this.lock = new AsyncLock()
  }

  getNode(): ResourceNode {
    return this.node;
  }

  getDatabase(): string {
    return this.database;
  }

  getLock(): AsyncLock {
    return this.lock
  }

  getMountHandle(): string | undefined {
    return this.mountHandle
  }

  start(node: ResourceNode): Promise<void> {
    this.node = node
    this.logger.debug("ContextManager is started")

    if (!this.option.database) {
      return Promise.reject(new Error("Database name is missing."));
    }
    this.database = this.option.database

    // ストレージを準備
    this.journalDb = new JournalDb(this.database)
    this.csnDb = new CsnDb(this.database)
    let promise = Promise.all([this.journalDb.start(), this.csnDb.start()]).then(_ => { })

    // スレーブ動作で同期するのためのサブスクライバを登録
    this.subscriber = new TransactionJournalSubscriber(this, this.journalDb, this.csnDb)
    promise = promise.then(() => {
      return node.subscribe(CORE_NODE.PATH_TRANSACTION.replace(/:database\b/g, this.database), this.subscriber)
    })
    promise = promise.then(() => {
      // コンテキストマネージャのRestサービスを登録
      this.server = new ContextManagementServer(this, this.journalDb, this.csnDb)
      this.connect()
    })

    return promise
  }

  stop(node: ResourceNode): Promise<void> {
    return Promise.resolve()
      .then(() => {
        if (this.mountHandle) return this.node.unmount(this.mountHandle).catch()
      });
  }

  connect(): Promise<void> {
    let promise = Promise.resolve()
    const mountHandle = this.mountHandle
    this.mountHandle = undefined

    if (mountHandle) {
      promise = promise.then(() => { return this.node.unmount(mountHandle).catch() })
    }
    promise = promise.then(() => {
      this.node.mount(CORE_NODE.PATH_CONTEXT.replace(/:database\b/g, this.database), "singletonMaster", this.server)
        .then(mountHandle => {
          // マスターを取得した場合のみ実行される
          // TODO 時間待ちのための時刻保存
          // TODO マスターを取得した場合、他のサブセットを自分と同じcsnまでロールバックさせるメッセージを送信
          this.mountHandle = mountHandle
        })
    })
    return promise
  }

  checkUniqueConstraint(csn: number, request: TransactionRequest): Promise<object> {
    // TODO ユニーク制約についてはクエリーを発行して確認 前提csnはジャーナルの最新を使用しなればならない
    if (request.type == TransactionType.INSERT && request.new) {
      // TODO 追加されたオブジェクトと一意属性が競合していないかを調べる
      return Promise.resolve(request.new)
    } else if(request.type == TransactionType.UPDATE && request.before) {
      let newObj = TransactionRequest.applyOperator(request)
      return Promise.resolve(newObj)
    } else if(request.type == TransactionType.DELETE && request.before) {
      return Promise.resolve(request.before)
    }else{
      throw new Error('checkConsistent error');
    }
}
}