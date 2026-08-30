require('dotenv').config()
require("@nomiclabs/hardhat-ethers")
require('solidity-docgen');
import { HardhatUserConfig } from "hardhat/config";
import "@nomiclabs/hardhat-ethers"
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-network-helpers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-gas-reporter";
import "solidity-coverage";
import "hardhat-contract-sizer"

const solidityConfig = {
    version: "0.8.36",
    settings: {
        evmVersion: "cancun",
        optimizer: {
            enabled: true,
            runs: 200,
            details: { yul: true },
        },
    },
}

export default{
    defaultNetwork: "hardhat",
    solidity: solidityConfig,
    contractSizer: {
        runOnCompile: true
    },
    networks: {
        hardhat: {
            allowUnlimitedContractSize: true,
            accounts: {
                count: 2000
            }
        },
        vinuchain: {
            url: process.env.VINUCHAIN_RPC_URL || 'https://rpc.vinuchain.org',
            chainId: 207,
            accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
        }
    }
}
