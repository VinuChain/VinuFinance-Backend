require('dotenv').config()
require("@nomiclabs/hardhat-ethers")
require('solidity-docgen');
import { HardhatUserConfig } from "hardhat/config";
import "@nomiclabs/hardhat-ethers"
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-contract-sizer"

export default{
    defaultNetwork: "hardhat",
    solidity: {
        version: "0.8.19",
        settings: {
            optimizer: {
            enabled: true,
            runs: 200,
            details: { yul: false },
            },
        },
    },
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