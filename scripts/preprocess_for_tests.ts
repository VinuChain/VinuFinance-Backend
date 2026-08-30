import * as fs from "fs";

const addTimestampSupport = (contractSrc, includeLoanIdx = false) => {
    const loanIdxShim = includeLoanIdx
        ? '    function setLoanIdx(uint256 _loanIdx) external { loanIdx = _loanIdx; }\n'
        : ''
    contractSrc = contractSrc.replace('// TMP-TIMESTAMP-METHODS', `
    uint32 time;
    function setTime(uint32 _time) external { time = _time; }
    function getTime() public view returns (uint32) { return time; } 
${loanIdxShim}
    `)
    contractSrc = contractSrc.replace(/block\.timestamp/g, 'getTime()')
    return contractSrc
}

const preprocessContract = (contractSrc, includeLoanIdx = false) => {

    contractSrc = contractSrc.replace(/contract (\S+)/g, 'contract $1_parsed')

    contractSrc = addTimestampSupport(contractSrc, includeLoanIdx)
    /*if (DISABLE_REVERTS) {
        contractSrc = disableReverts(contractSrc)
    }

    // Soliditypp doesn't handle tx.origin well
    if (TX_ORIGIN_TO_MSG_SENDER) {
        contractSrc = contractSrc.replace(/tx\.origin/g, 'msg.sender')
    }

    if (ALLOW_DISABLE) {
        contractSrc = allowDisable(contractSrc)
    }*/

    return contractSrc
}

const transpileContract = (path) => {
    let contractSrc = fs.readFileSync(path, { encoding : 'utf-8' })
    contractSrc = preprocessContract(contractSrc, path.endsWith('/BasePool.sol'))

    // Controller derives the canonical BasePool creation hash from its import.
    // Point the parsed controller at the timestamp-shimmed test pool too.
    if (path.endsWith('/Controller.sol')) {
        contractSrc = contractSrc
            .replace('import "./BasePool.sol";', 'import "./BasePool_parsed.sol";')
            .replace(/\bBasePool\b/g, 'BasePool_parsed')
    }

    const newPath = path.replace('.sol', '_parsed.sol')

    fs.writeFileSync(newPath, contractSrc, { encoding : 'utf-8' })
}

transpileContract('./contracts/BasePool.sol')
transpileContract('./contracts/Controller.sol')
