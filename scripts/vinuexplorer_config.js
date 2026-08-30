// VinuExplorer's Blockscout-compatible chain registration for Hardhat Verify.
// Keep this data in a small CommonJS module so CI can validate the resolved
// values without loading a TypeScript Hardhat config or making a submission.
const vinuExplorerChain = {
  network: "vinuchain",
  chainId: 207,
  urls: {
    // VinuExplorer's API docs identify this as the mainnet API base URL.
    apiURL: "https://mainnet.vinuexplorer.org/api",
    browserURL: "https://mainnet.vinuexplorer.org",
  },
};

module.exports = { vinuExplorerChain };
