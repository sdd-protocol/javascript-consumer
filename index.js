'use strict'

const Redis = require('ioredis')

const ProtocolVersion = 4

const DefaultTimeouts = {
  connect: 1000,
  reconnect: 3000,
  ack: 5000,
  customCommands: 2000
}

const DefaultLoggerNoOp = {
  log: (..._) => {},
  error: (..._) => {}
}

class MismatchedSequenceNumber extends Error {
  constructor(currentSeqNo, expectedSeqNo, ...args) {
    super(...args)
    this.current = currentSeqNo
    this.expected = expectedSeqNo
  }

  get [Symbol.toStringTag]() {
    return `current=${this.current} expected=${this.expected}`
  }
}

class ConfigurationError extends Error {}

module.exports = class {
  constructor (localId, prefix, redisCfg, options = {}) {
    this.id = localId
    this.prefix = prefix
    this.redisCfg = redisCfg
    this.displayId = null
    this.logger = options.logger || DefaultLoggerNoOp
    this.timeouts = options.timeouts || DefaultTimeouts
    this.reconnectable = options.hasOwnProperty('allowReconnections') ? options.allowReconnections : true
    this.disconnectOnExitSignals = options.hasOwnProperty('disconnectOnExitSignals') ? options.disconnectOnExitSignals : true
    this.messageStats = options.hasOwnProperty('messageStats') ? options.messageStats : { rx: 0, tx: 0 }
    this.awaitingAckedResponse = {}
  }

  async clear () {
    return this._estabPublish('clear')
  }

  async writeAt (column, row, message) {
    return this._estabPublish(`writeat ${column} ${row} ${message}`)
  }

  async toggleDisplay (on) {
    return this._estabPublish(`toggleDisplay ${!!on ? 'on' : 'off'}`)
  }

  async toggleCursor (on) {
    return this._estabPublish(`toggleCursor ${!!on ? 'on' : 'off'}`)
  }

  async toggleCursorBlink (on) {
    return this._estabPublish(`toggleCursorBlink ${!!on ? 'on' : 'off'}`)
  }

  disconnect () {
    return this._disconnect(true)
  }

  async issueCustomCommand (command, ...args) {
    return new Promise(async (resolve, reject) => {
      if (!this._hasConnectedOnce || !this._ackChan) {
        reject(`not connected`)
        return
      }

      const nextSeqNo = this._seqNo + 1
      this.awaitingAckedResponse[nextSeqNo] = { command, resolve }
      let sentSeqNo = await this._estabPublish(`${command} ${args.join(' ')}`)

      if (sentSeqNo !== nextSeqNo) {
        throw new MismatchedSequenceNumber(sentSeqNo, nextSeqNo, 'sent vs. next')
      }

      this.awaitingAckedResponse[nextSeqNo].timeoutHandle = setTimeout(() => {
        delete this.awaitingAckedResponse[sentSeqNo]
        reject(`custom command '${command}' timed out waiting for response (seqNo=${sentSeqNo})!`)
      }, this.timeouts.customCommands)
    });
  }

  async connect (displayId, ...args) {
    if (!this.id || !displayId || !this.prefix) {
      throw new ConfigurationError(`Unspecified id (${this.id}), displayId (${displayId}) or prefix (${this.prefix})`)
    }

    const [onDisconnect, onReconnect] = args
    this.displayId = displayId
    this._hasConnectedOnce = false
    this._connectConn = new Redis(this.redisCfg)
    this._on = {
      disconnect: onDisconnect,
      reconnect: onReconnect
    }

    if (!this.publishConn) {
      this.publishConn = new Redis(this.redisCfg)
    }

    if (!this.publishConn || !this._connectConn) {
      throw new ConfigurationError('Cannot connect to Redis server')
    }

    return new Promise((resolve, reject) => {
      this._respChan = `${this.prefix}ctrl-init:request:resp`

      this._connectConn.on('message', (_channel, message) => {
        this.messageStats.rx++
        const comps = message.split(' ')

        if (comps.length >= 3 && comps[0] === this.displayId && comps[2] === this.id) {
          if (comps[1] === 'ok') {
            const estabChan = `${this.prefix}estab:${this.displayId}|${this.id}`

            this._estabPublish = async (m) => {
              if (!this._toHandle) {
                this._toHandle = setTimeout(() => {
                  this.logger.error(`Ack TO Fired! expected ${this._expectNextAckIs} (seqNo: ${this._seqNo})`)
                  this._disconnect()
                }, this.timeouts.ack)
              }

              this._seqNo += 1
              await this._publish(estabChan, `${this._seqNo} ${m}`)
              return this._seqNo
            }

            this._ackChan = `${estabChan}:ack`
            this._ackListener = new Redis(this.redisCfg)

            this._ackListener.on('message', (_c, message) => {
              this.messageStats.rx++
              const comps = message.split(/\s+/)
              const mSN = Number(comps[0])

              if (Number.isNaN(mSN)) {
                this.logger.error(`Bad seqNo! ${message}`)
                return
              }

              if (this.awaitingAckedResponse[mSN]) {
                clearTimeout(this.awaitingAckedResponse[mSN].timeoutHandle)
                this.awaitingAckedResponse[mSN].resolve(comps.splice(1).join(' '))
                delete this.awaitingAckedResponse[mSN]
              }

              if (mSN === this._expectNextAckIs) {
                clearTimeout(this._toHandle)
                this._toHandle = null
                this._expectNextAckIs = mSN + 1
              } else {
                throw new MismatchedSequenceNumber(mSN, this._expectNextAckIs)
              }
            })

            this._ackListener.subscribe(this._ackChan, (err) => {
              if (err) {
                return reject('Ack listener setup')
              }

              if (this.disconnectOnExitSignals) {
                const sigHandler = (_signal) => {
                  // allows the option to be changed at runtime (though it probably shouldn't be...)
                  if (this.disconnectOnExitSignals) {
                    this._disconnect(true);
                  }

                  process.exit(0);
                }

                ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => process.on(signal, sigHandler));
              }

              return resolve(this)
            })

            this.logger.log(`Established on "${estabChan}" (${this._hasConnectedOnce})`)
            this._connectConn.unsubscribe(this._respChan)

            if (this._hasConnectedOnce) {
              if (this._on.reconnect) {
                this._on.reconnect(this, estabChan)
              }
            }

            // not sure these are all necessary...
            clearTimeout(this._rcHandle)
            clearTimeout(this._toHandle)
            clearTimeout(this._connectTOHandle)
            this._rcHandle = this._toHandle = this._connectTOHandle = null
            this._hasConnectedOnce = true
          } else if (comps[1] === 'reject') {
            comps[3].__proto__.wasFatal = true
            reject(comps[3])

            if (comps[3] === 'bad_protocol_version') {
              this.reconnectable = false
              this._disconnect()
            }
          }
        }
      })

      this._realConnect(reject)
    })
  }

  _publish (channel, message) {
    this.messageStats.tx++
    return this.publishConn.publish(channel, message)
  }

  _realConnect (reject = (msg) => { throw new Error(msg) }) {
    this._seqNo = 0
    this._expectNextAckIs = 1

    this._connectConn.subscribe(this._respChan, (err) => {
      if (err) {
        return reject('Subscription reject')
      }
    })

    const connParams = [`${this.prefix}ctrl-init`, `${this.id} request ${this.displayId} ${ProtocolVersion}`]
    this.logger.log('Issuing connect attempt:', ...connParams)
    this._publish(...connParams)

    this._connectTOHandle = setTimeout(() => {
      clearTimeout(this._rcHandle)
      this._rcHandle = null
      this.logger.log(`Connection attempt '${this.id} request ${this.displayId}' timed out!`)
      this._disconnect()
    }, this.timeouts.connect)
  }

  _disconnect (selfIssued = false) {
    if (selfIssued) {
      this._estabPublish('disconnect')
    }

    if (this._on.disconnect && this._hasConnectedOnce) {
      this._on.disconnect(this._expectNextAckIs, this._seqNo)
    }

    this._estabPublish = (..._a) => { }

    clearTimeout(this._toHandle)
    this._toHandle = null

    if (this._ackListener) {
      this._ackListener.unsubscribe(this._ackChan)
      this._ackListener.disconnect()
      delete this._ackListener, this._ackListener = this._ackChan = null
    }

    if (!this.reconnectable || selfIssued) {
      clearTimeout(this._rcHandle)
      clearTimeout(this._toHandle)
      clearTimeout(this._connectTOHandle)
    }

    if (selfIssued) {
      this._connectConn.disconnect()
      this.publishConn.disconnect()
    }

    // return before reconnect if reconnect is disabled or if disconnect() was called directly (selfIssued===true)
    if (!this.reconnectable || selfIssued) {
      return
    }

    if (!this._rcHandle) {
      this.logger.log(`Waiting ${this.timeouts.reconnect || 0}ms to attempt reconnection...`)
      this._rcHandle = setTimeout(this._realConnect.bind(this), this.timeouts.reconnect || 0)
    } else {
      this.logger.error('RC handle exists!')
    }
  }
}
