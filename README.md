# Collateral Auction Bot Example

This is an example Auction bot that places bids for ongoing liquidation of unsafe vaults for vaults with LKSM as collateral.

#### :warning: this code is an example, don't run it without modification with any significant amount of funds 

### Description

The initial Bot currency is LKSM. It's designed in this way to keep receiving staking rewards.
All Collateral Auctions in Acala/Karura are meant to sell collateral for kUSD. So to place a bit, the Bot needs to borrow kUSD against LKSM collateral once he finds opened auction. 

As the Bot needs to have a private_key/seed to perform any operation we assume that any key stored in .env variables can be compromised. For this reason, the Bot consists of 2 accounts: **stake account** and **proxy account**.
Proxy account should have limited access to the stash account, e.g. allowing to make bids in the auction or taking loans, with no permissions for transfers or any other operations that can lean to stealing funds.
Read more about [Proxy Accounts here](https://wiki.polkadot.network/docs/learn-proxies).
The Bot needs to hold keys ONLY from the Proxy account.

### Flow

When Bot starts, it checks all available amounts of kUSD and tries to pay it back for LKSM Vault. It also checks the current required ratio, and current debt in LKSM vault and finds out the amount of kUSD that can be borrowed and later used as a bid in a collateral auction

After, it takes all available auctions and searches for the auction with a target amount lesser than available funds in the Bot (maximum amount of kUSD that can be borrowed).

If the Bot finds the auction, it borrows the target amount of kUSD from LKSM vault and places them as a bid.

### Suggestions for improvements for production-ready Bot:
1. Handling won auctions results.
Currently, if the auction is won, the Bot doesn't take any action. The Bot will receive one of the collaterals that can be swapped for kUSD to repay debts for LKSM vault; or can be swapped for LKSM and added as collateral. We left this logic totally up to a developer.

2. Filtering auctions
You may want to participate in auctions for certain collateral types or filter out target amounts that look more profitable.

### Running Bot

1. Set `.env` file

As an example we provided `.env.example` with next content:
```bash=
NODE_ENV_OVERRIDE=development
#NODE_ENV_OVERRIDE=production

PROXY_ACCOUNT_SEED=//Bob
STASH_ACCOUNT=t6X8qpY26nsi6WDMkhbyaTz6cLtNBt7xfs4H9k94D3kM1Lm
LOG_LEVEL=debug
#ENV_CONFIG=development
ENV_CONFIG=staging
```

2. Install dependencies

```bash=
yarn
```

3. Run bot:
```bash=
yarn start
```

