#!/usr/bin/env node

const assert = require("assert");
const { vinuExplorerChain } = require("./vinuexplorer_config");

assert.deepStrictEqual(vinuExplorerChain, {
  network: "vinuchain",
  chainId: 207,
  urls: {
    apiURL: "https://mainnet.vinuexplorer.org/api",
    browserURL: "https://mainnet.vinuexplorer.org",
  },
});

console.log(JSON.stringify({
  pass: true,
  network: vinuExplorerChain.network,
  chainId: vinuExplorerChain.chainId,
  apiURL: vinuExplorerChain.urls.apiURL,
  browserURL: vinuExplorerChain.urls.browserURL,
  submission: "not attempted",
}, null, 2));
