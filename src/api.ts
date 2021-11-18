import '@acala-network/types'

import { ApiRx, Keyring, WsProvider } from '@polkadot/api'
import { FixedPointNumber } from '@acala-network/sdk-core'
import { LoanRx } from '@acala-network/sdk-loan'
import { Logger } from '@open-web3/util/logger'
import { WalletRx } from '@acala-network/sdk-wallet'
import { filter, firstValueFrom, map, of, takeWhile, timeout } from 'rxjs'
import { options } from '@acala-network/api'
import type { AccountId } from '@polkadot/types/interfaces'
import type { AuctionId, CurrencyId } from '@acala-network/types/interfaces'
import type { KeyringPair } from '@polkadot/keyring/types'
import type { SubmittableExtrinsic } from '@polkadot/api/types'

import config from './config'

import { fetchOraclePrices, lksmToKsmRate } from './utils'

type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T

export default class Api {
  constructor(
    public readonly testMode: boolean,
    public readonly api: ApiRx,
    public readonly pair: KeyringPair | undefined,
    public readonly address: AccountId,
    public readonly query: typeof api.query,
    public readonly tx: typeof api.tx,
    public readonly wallet: WalletRx,
    public readonly loans: Record<typeof config['collateralCurrencies'][number], LoanRx>,
    public readonly lksmToKsmRate: FixedPointNumber,
    public readonly logger: Logger
  ) {}

  public static async create(
    testMode: boolean,
    endpoints: string[],
    seed: string | Promise<string> | null,
    stash: string,
    logger: Logger
  ): Promise<Api> {
    const ws = new WsProvider(endpoints)
    const api = new ApiRx(options({ provider: ws }))
    await firstValueFrom(api.isReady)

    const address = api.createType('AccountId', stash)

    let pair
    let signer
    if (seed) {
      const keyring = new Keyring({ type: 'sr25519' })
      pair = keyring.addFromUri(await seed)

      signer = api.createType('AccountId', pair.address)
    }

    const wallet = new WalletRx(api)

    const loans = {} as Record<string, LoanRx>
    for (const currency of config.collateralCurrencies) {
      loans[currency] = new LoanRx(api, currency, address.toString(), wallet)
    }

    if (signer && !testMode) {
      const bal = await firstValueFrom(wallet.queryNativeBalances(signer))
      if (bal.availableBalance.balance.lte(new FixedPointNumber(1))) {
        logger.warn('Signer balance low', {
          signer: signer.toString(),
          signerBalance: bal.availableBalance.balance.toString(),
          stash: address.toString(),
        })
      } else {
        logger.debug({
          signer: signer.toString(),
          signerBalance: bal.availableBalance.balance.toString(),
          stash: address.toString(),
        })
      }
    }

    return new Api(testMode, api, pair, address, api.query, api.tx, wallet, loans, await lksmToKsmRate(api), logger)
  }

  public getAuctions() {
    return firstValueFrom(
      this.query.auctionManager.collateralAuctions.entries().pipe(
        map((auctions) => {
          return auctions.flatMap(([key, maybeAuction]) => {
            const id = key.args[0]
            if (maybeAuction.isNone) {
              this.logger.warn('maybeAuction is none', key)
              return []
            }
            const auction = maybeAuction.unwrap()
            return [{ id, auction }]
          })
        })
      )
    )
  }

  public getAuctionInfo(id: AuctionId) {
    return firstValueFrom(this.query.auction.auctions(id).pipe(map((info) => (info.isNone ? null : info.unwrap()))))
  }

  public getPosition(currency: keyof Api['loans']) {
    return firstValueFrom(this.loans[currency].position)
  }

  public getBalance(currency: string) {
    return firstValueFrom(this.wallet.queryBalance(this.address, currency))
  }

  public async getCollateralPositions() {
    const context = {} as Record<
      string,
      {
        oraclePrice: number
        rate: FixedPointNumber
        liquidationRatio: number
        liquidationPriceMulpiler: number
      }
    >

    const liquidationTxs = [] as ReturnType<Api['sendUnsigned']>[]

    for (const currency of config.collateralCurrencies) {
      const currencyId = this.wallet.getToken(currency).toCurrencyId(this.api)
      const rate = new FixedPointNumber(
        (await firstValueFrom(this.query.cdpEngine.debitExchangeRate(currencyId))).unwrap().toString(),
        0
      )
      rate.forceSetPrecision(18)

      let oraclePrice
      let liquidationPriceMulpiler
      const price = await fetchOraclePrices(this.api)
      if (currency === 'LKSM') {
        oraclePrice = price.KSM.value * this.lksmToKsmRate.toNumber()
        liquidationPriceMulpiler = 1 / this.lksmToKsmRate.toNumber()
      } else {
        oraclePrice = price[currency].value
        liquidationPriceMulpiler = 1
      }

      const params = await firstValueFrom(this.query.cdpEngine.collateralParams(currencyId))
      const liquidationRatio = new FixedPointNumber(params.liquidationRatio.unwrap().toString(), 0)
      liquidationRatio.forceSetPrecision(18)

      context[currency] = {
        oraclePrice,
        rate,
        liquidationRatio: liquidationRatio.toNumber(),
        liquidationPriceMulpiler,
      }
    }

    const getEntries = (currencyId: CurrencyId, startKey?: string) =>
      firstValueFrom(
        this.query.loans.positions.entriesPaged({
          args: [currencyId],
          pageSize: 100,
          startKey,
        })
      )

    const processEntry = (currencyId: CurrencyId, entry: Awaited<ReturnType<typeof getEntries>>[number]) => {
      const { oraclePrice, rate, liquidationRatio, liquidationPriceMulpiler } = context[currencyId.asToken.toString()]
      const [key, pos] = entry
      const [currency, acc] = key.args
      if (currency.eq(currencyId)) {
        const collateral = new FixedPointNumber(pos.collateral.toString(), 0)
        collateral.forceSetPrecision(12)
        const collateralValue = collateral.toNumber() * oraclePrice

        const debit = new FixedPointNumber(pos.debit.toString(), 0)
        debit.forceSetPrecision(12)
        const debitValue = debit.toNumber() * rate.toNumber()

        const collateralRatio = collateralValue / debitValue

        if (collateralRatio < liquidationRatio) {
          this.logger.warn('Trigger liquidate', {
            account: acc.toString(),
            collateralCurrency: currencyId.toString(),
            collateralValue,
            debitValue,
            collateralRatio,
            liquidationRatio,
          })
          liquidationTxs.push(this.sendUnsigned(this.tx.cdpEngine.liquidate(currencyId, acc)))
        }

        if (collateralRatio > liquidationRatio * 2) {
          return undefined
        }

        return {
          account: acc.toString(), //.replace(/.{25}$/g, new Array(25).fill('x').join('')),
          collateralCurrency: currencyId.toString(),
          collateral: collateral.toNumber(),
          collateralValue,
          debitValue,
          collateralRatio,
          liquidationPrice: ((debitValue * liquidationRatio) / collateral.toNumber()) * liquidationPriceMulpiler,
          liquidationRatio,
        }
      }
    }

    const topRiskPositions = {} as Record<string, NonNullable<ReturnType<typeof processEntry>>[]>

    const processEntries = (currencyId: CurrencyId, entries: Awaited<ReturnType<typeof getEntries>>) => {
      const currency = currencyId.asToken.toString()
      const positions = topRiskPositions[currency] || (topRiskPositions[currency] = [])

      for (const entry of entries) {
        const pos = processEntry(currencyId, entry)
        if (pos) {
          positions.push(pos)
        }
      }

      if (entries.length > 0) {
        return entries[entries.length - 1][0]
      }
    }

    for (const currency of config.collateralCurrencies) {
      const currencyId = this.wallet.getToken(currency).toCurrencyId(this.api)
      const entries = await getEntries(currencyId)
      let nextKey = processEntries(currencyId, entries)
      while (nextKey) {
        const entries = await getEntries(currencyId, nextKey.toHex())
        nextKey = processEntries(currencyId, entries)
      }

      const positions = topRiskPositions[currency] || (topRiskPositions[currency] = [])
      positions.sort((a, b) => a.collateralRatio - b.collateralRatio)
    }

    // wait until liquidation tx are broadcasted
    await Promise.all(liquidationTxs.map(firstValueFrom))

    return topRiskPositions
  }

  public adjustLoan(
    currency: string,
    depositAmount: FixedPointNumber,
    repayAmount: FixedPointNumber,
    debitExchangeRate: FixedPointNumber
  ) {
    this.logger.debug('adjustLoan', {
      currency,
      depositAmount: depositAmount.toString(),
      repayAmount: repayAmount.toString(),
    })

    const newAmount = new FixedPointNumber(repayAmount.toNumber(4), repayAmount.getPrecision())
    const debit = newAmount.div(debitExchangeRate).mul(new FixedPointNumber(-1))

    const tx = this.tx.honzon.adjustLoan(
      this.wallet.getToken(currency).toCurrencyId(this.api),
      depositAmount.toChainData(),
      debit.toChainData()
    )
    return this.signAndSend(this.proxyTx(tx, 'Loan'))
  }

  public bid(id: AuctionId, amount: FixedPointNumber, debitExchangeRate: FixedPointNumber) {
    this.logger.info('bid', {
      id: id.toHuman(),
      amount: amount.toString(),
    })

    const debit = amount.div(debitExchangeRate)
    const tx = [
      this.proxyTx(
        this.tx.honzon.adjustLoan(this.wallet.getToken('LKSM').toCurrencyId(this.api), 0, debit.toChainData()),
        'Loan'
      ),
      this.proxyTx(this.tx.auction.bid(id, amount.toChainData()), 'Auction'),
    ]
    return this.signAndSend(this.tx.utility.batchAll(tx))
  }

  private proxyTx(tx: SubmittableExtrinsic<'rxjs'>, proxy: string) {
    return this.tx.proxy.proxy(this.address, proxy, tx)
  }

  public sendUnsigned(tx: SubmittableExtrinsic<'rxjs'>) {
    this.logger.info('sendUnsigned', tx.method.toHuman())
    return this.send(tx)
  }

  public async signAndSend(tx: SubmittableExtrinsic<'rxjs'>) {
    const pair = this.pair

    if (!pair) {
      throw new Error('No signing keypair')
    }

    this.logger.info('signAndSend', tx.method.toHuman())

    if (this.testMode) {
      this.logger.debug('Test Mode: Skipping sending tx')
      return Promise.resolve(of())
    }

    const signedTx = await firstValueFrom(tx.signAsync(pair))

    return this.send(signedTx)
  }

  private send(tx: SubmittableExtrinsic<'rxjs'>) {
    if (this.testMode) {
      this.logger.debug('Test Mode: Skipping sending tx')
      return of()
    }

    const txHash = tx.hash.toHex()
    this.logger.info({ txHash: `https://karura.subscan.io/extrinsic/${txHash}`, nonce: tx.nonce.toHuman() })
    return tx.send().pipe(
      filter((res) => !res.status.isReady),
      takeWhile((res) => {
        this.logger.debug('signAndSend updated', {
          txHash,
          status: res.status.toHuman(),
        })
        if (res.status.isInBlock) {
          this.logger.info('signAndSend isInBlock', {
            txHash,
            blockHash: res.status.asInBlock.toString(),
          })
        }
        if (res.status.isFinalized) {
          this.logger.info('signAndSend isFinalized', {
            txHash,
            blockHash: res.status.isFinalized.toString(),
          })
          return false
        }
        return true
      }),
      timeout(60000)
    )
  }
}
