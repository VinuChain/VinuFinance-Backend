#!/usr/bin/env node

const assert = require("assert");
const { vinuExplorerChain, vinuTestnetExplorerChain } = require("./vinuexplorer_config");

assert.deepStrictEqual(vinuExplorerChain, {
  network: "vinuchain",
  chainId: 207,
  urls: {
    apiURL: "https://mainnet.vinuexplorer.org/api",
    browserURL: "https://mainnet.vinuexplorer.org",
  },
});

assert.deepStrictEqual(vinuTestnetExplorerChain, {
  network: "vinuchainTestnet",
  chainId: 206,
  urls: {
    apiURL: "https://testnet.vinuexplorer.org/api",
    browserURL: "https://testnet.vinuexplorer.org",
  },
});

console.log(JSON.stringify({
  pass: true,
  networks: [vinuExplorerChain, vinuTestnetExplorerChain].map((chain) => ({
    network: chain.network,
    chainId: chain.chainId,
    apiURL: chain.urls.apiURL,
    browserURL: chain.urls.browserURL,
  })),
  submission: "not attempted",
}, null, 2));
