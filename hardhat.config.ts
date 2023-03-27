import { HardhatUserConfig, task } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomiclabs/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";

require("dotenv").config();

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.17",
        settings: {
          optimizer: {
            enabled: true,
            runs: 5,
          },
        },
      },
      {
        version: "0.7.6",
      },
    ],
    overrides: {
      "contracts/periphery/WETH9.sol": {
        version: "0.7.6",
      },
      "contracts/v1Contracts/*.sol": {
        version: "0.7.6",
      },
    },
  },

  // *** TODO CONFIGURE NETWORKS AND VERIFICATION ***
  networks: {
    optimismMainnet: {
      url:
        "https://optimism-mainnet.infura.io/v3/" + process.env.INFURA_API_KEY,
      gasPrice: 10000,
      chainId: 10,
      timeout: 40000,
    },
    optimismGoerli: {
      url:
        "https://opt-goerli.g.alchemy.com/v2/" +
        process.env.ALCHEMY_API_KEY_GOERLI,
      gasPrice: 10000,
      chainId: 420,
      accounts: (process.env.OP_GOERLI_ADMIN_KEY && process.env.OP_GOERLI_PROXY_ADMIN_KEY) ? [
        process.env.OP_GOERLI_ADMIN_KEY,
        process.env.OP_GOERLI_PROXY_ADMIN_KEY,
      ] : [],
      timeout: 40000,
    },
    arbitrumGoerli: {
      url: "https://arbitrum-goerli.infura.io/v3/" + process.env.INFURA_API_KEY,
      gasPrice: 10000,
      chainId: 421613,
      accounts: (process.env.ARB_GOERLI_ADMIN_KEY && process.env.ARB_GOERLI_PROXY_ADMIN_KEY) ? [
        process.env.ARB_GOERLI_ADMIN_KEY,
        process.env.ARB_GOERLI_PROXY_ADMIN_KEY,
      ] : [],
      timeout: 40000,
    },

  },
  etherscan: {
    // apiKey: process.env.ETHERSCAN_API_OPTIMISM_MAINNET,
    apiKey: process.env.ETHERSCAN_API_ARBITRUM,
  },
};

export default config;
