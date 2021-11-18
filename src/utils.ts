import '@acala-network/types'

import { ApiRx } from '@polkadot/api'
import { FixedPointNumber, Token, TokenPair } from '@acala-network/sdk-core'
import { firstValueFrom } from 'rxjs'
import axios from 'axios'

const mapping: Record<string, string> = {
  KSM: 'kusama',
}

export const fetchPrice = async (from: string, to: string): Promise<number> => {
  const baseURL = 'https://api.coingecko.com/api/v3'
  from = mapping[from] || from
  to = to.toLowerCase()
  const params = {
    ids: from,
    vs_currencies: to.toLowerCase(),
  }
  const result = await axios.get('/simple/price', { params, baseURL })

  const price = (result.data as Record<string, Record<string, number>>)[from]?.[to]

  if (result.status >= 400 || !price) {
    throw Error(`Price fetch failed (${result.status} ${result.statusText}): ${JSON.stringify(result.data)}.`)
  }

  return price
}

export const fetchOraclePrices = async (api: ApiRx) => {
  // [[{"token":"KSM"}, {"value":"0x000000000000000bf2d680f45bc94000","timestamp":1628463588508}]]
  const res = await firstValueFrom(api.rpc.oracle.getAllValues('Acala'))
  return res.reduce((prices, [key, value]) => {
    const timestampedValue = value.unwrap()
    const price = new FixedPointNumber(timestampedValue.value.toString(), 0)
    price.forceSetPrecision(18)
    prices[key.asToken.toString()] = {
      value: price.toNumber(),
      timestamp: new Date(timestampedValue.timestamp.toNumber()).toISOString(),
    }
    return prices
  }, {} as Record<string, { value: number; timestamp: string }>)
}

export const lksmToKsmRate = async (api: ApiRx) => {
  const lksmtTotal = await firstValueFrom(api.query.tokens.totalIssuance({ Token: 'LKSM' }))
  const ksmTotal = await firstValueFrom(api.query.homaLite.totalStakingCurrency())
  const lksm = new FixedPointNumber(lksmtTotal.toString(), 12)
  const ksm = new FixedPointNumber(ksmTotal.toString(), 12)
  return ksm.div(lksm)
}

export const fetchSwapPrice = async (api: ApiRx, from: string, to: string): Promise<number> => {
  const pair = TokenPair.fromCurrencies(new Token(from).toCurrencyId(api), new Token(to).toCurrencyId(api))
  const [bal1, bal2] = await firstValueFrom(api.query.dex.liquidityPool(pair.toTradingPair(api)))
  return bal1.muln(1000).div(bal2).toNumber() / 1000
}
