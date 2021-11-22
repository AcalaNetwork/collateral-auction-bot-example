import { firstValueFrom, lastValueFrom } from 'rxjs'

import { FixedPointNumber } from '@acala-network/sdk-core'

import { defaultLogger } from '@open-web3/util'

import Api from './api'
import config from './config'

const logger = defaultLogger.createLogger('bidder')

export const main = async () => {
  const api = await Api.create(
    config.env !== 'production',
    config.ws,
    config.secrets.seed(),
    config.stash,
    logger.createLogger('api')
  )

  const pos = await api.getPosition('LKSM')

  const lksmBal = await api.getBalance('LKSM')
  const kusdBal = await api.getBalance('KUSD')
  const depositLksm = lksmBal.availableBalance.gte(FixedPointNumber.fromRational(1, 10, 12))
  const repayKusd = kusdBal.availableBalance.gte(new FixedPointNumber(100, 12))
  if (depositLksm || repayKusd) {

    const repayAmount = kusdBal.availableBalance.sub(new FixedPointNumber(21)) // -21 kUSD to avoid min debt issue
    logger.info('adjustLoan', {
      LKSM: lksmBal.availableBalance.toString(),
      kUSD: repayAmount.toString(),
    })
    // try to repay all available kUSD to LKSM vault
    await lastValueFrom(await api.adjustLoan('LKSM', lksmBal.availableBalance, repayAmount, pos.debitExchangeRate))
  }

  const maxDebitAmount = pos.collateralAmount.div(new FixedPointNumber(config.minCollateralRatio))
  const initialAvailableAmount = maxDebitAmount.sub(pos.debitAmount)
  const collateralRatio = pos.collateralRatio.toNumber()
  const collateralRatioDangerous = collateralRatio < config.alertCollateralRatio

  if (collateralRatioDangerous) {
    logger.error('Collateral ratio dangerous', { collateralRatio })
  }

  const detailedInfo = config.env === 'development' || collateralRatioDangerous
  if (detailedInfo) {
    logger.info({
      collateral: pos.collateral.toNumber(),
      collateralRatio,
      collateralAmount: pos.collateralAmount.toNumber(),
      debitAmount: pos.debitAmount.toNumber(),
      availableAmount: initialAvailableAmount.toNumber(),
    })
  }

  const availableAmount = initialAvailableAmount

  const auctions = await api.getAuctions()
  for (const { id, auction } of auctions) {
    logger.debug('auction', {
      id: id.toHuman(),
      auction: auction.toHuman(),
    })

    const auctionInfo = await api.getAuctionInfo(id)
    if (!auctionInfo) {
      logger.warn('No auction info', id)
      continue
    }

    // TODO: optional to add auction filters: by collateral types, by prices for collateral, etc

    logger.debug('winning bid', auctionInfo.bid.toHuman())

    const winner = auctionInfo.bid.isSome && auctionInfo.bid.unwrap()[0]

    if (winner && winner.eq(api.address)) {
      logger.debug('Alraedy winner, skip.')
      continue
    }

    const target = new FixedPointNumber(auction.target.toString(), 0)
    target.forceSetPrecision(12)

    if (availableAmount.lte(new FixedPointNumber(0, 12))) {
      logger.info('No more money, skip.', availableAmount.toString())
      continue
    }

    const borrowAmount = target.min(availableAmount)

    await firstValueFrom(await api.bid(id, borrowAmount, pos.debitExchangeRate))

    // TODO: handling auction results: for example, if the auction is won -> swap collateral, repay kUSD debt, ...
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e)
    process.exit(1)
  })
