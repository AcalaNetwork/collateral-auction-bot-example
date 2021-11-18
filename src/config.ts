import { config } from 'dotenv'

config()

const getEnv = () => {
  const env = process.env.NODE_ENV_OVERRIDE || process.env.NODE_ENV
  switch (env) {
    case 'development':
    case 'staging':
    case 'production':
      return env
    default:
      return 'development'
  }
}

const getEnvConfig = (env?: string) => {
  switch (env) {
    case 'development':
    case 'staging':
    case 'production':
      return env
    default:
      return null
  }
}

const env = getEnv()
const configEng = getEnvConfig(process.env.ENV_CONFIG)

const envConfig = {
  production: {
    ws: [
      'wss://karura.api.onfinality.io/public-ws',
      'wss://karura-rpc-0.aca-api.network',
    ],
  },
  staging: {
    ws: [
      'wss://karura.api.onfinality.io/public-ws',
      'wss://karura-rpc-0.aca-api.network',
    ],
  },
  development: {
    ws: ['ws://localhost:9944'],
  },
}

const readSecret = (name: string) => async () => {
  const envSecret = process.env[name.toUpperCase()]
  if (envSecret) {
    return envSecret
  }
  throw new Error(`Parameter ${name} is not set`)
}

const sharedConfig = {
  env,
  logFilter: process.env.LOG_FILTER,
  logLevel: process.env.LOG_LEVEL,
  stash: process.env.STASH || '',
  slackWebHook: process.env.SLACK_WEBHOOK,
  minCollateralRatio: 2.6,
  alertCollateralRatio: 2.2,
  alertOraclePriceDiff: 0.04,
  secrets: {
    seed: readSecret('seed'),
  },
  collateralCurrencies: ['KSM', 'LKSM'] as ['KSM', 'LKSM'],
}

export default {
  ...sharedConfig,
  ...envConfig[configEng || env],
}
