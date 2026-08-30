#!/usr/bin/env node

const fs = require('fs')

const coveragePath = 'coverage/coverage-final.json'
const minimums = {
    'contracts/BasePool_parsed.sol': { s: 90, l: 90 },
    'contracts/Controller_parsed.sol': { s: 90, l: 90 },
    'contracts/EmergencyWithdrawal.sol': { s: 85, l: 85 },
    'contracts/MultiClaim.sol': { s: 85, l: 85 },
}
const metricNames = { s: 'statements', l: 'lines' }
const canonicalPairs = [
    ['contracts/BasePool.sol', 'contracts/BasePool_parsed.sol'],
    ['contracts/Controller.sol', 'contracts/Controller_parsed.sol'],
]

function fail(message) {
    console.error(`Coverage gate failed: ${message}`)
    process.exit(1)
}

if (!fs.existsSync(coveragePath)) {
    fail(`${coveragePath} does not exist; run npm run coverage first`)
}

let report
try {
    report = JSON.parse(fs.readFileSync(coveragePath, 'utf8'))
} catch (error) {
    fail(`could not parse ${coveragePath}: ${error.message}`)
}

function normalizedKey(key) {
    return key.replace(/\\/g, '/')
}

function findUniqueKey(suffix) {
    const matches = Object.keys(report).filter((key) => normalizedKey(key).endsWith(suffix))
    if (matches.length !== 1) {
        fail(`${suffix} must have exactly one coverage entry, found ${matches.length}: ${matches.join(', ') || 'none'}`)
    }
    return matches[0]
}

for (const [rawSuffix, parsedSuffix] of canonicalPairs) {
    findUniqueKey(rawSuffix)
    findUniqueKey(parsedSuffix)
}

const results = {}
for (const [suffix, floors] of Object.entries(minimums)) {
    const key = findUniqueKey(suffix)
    const data = report[key]
    results[suffix] = {}

    for (const [metric, floor] of Object.entries(floors)) {
        const counts = Object.values(data[metric] || {})
        if (counts.length === 0) {
            fail(`${suffix} has no ${metricNames[metric]} entries`)
        }

        const covered = counts.filter((count) => count > 0).length
        const total = counts.length
        if (covered === 0) {
            fail(`${suffix} has zero covered ${metricNames[metric]} entries`)
        }
        if (covered * 100 < total * floor) {
            fail(`${suffix} ${metricNames[metric]} coverage ${covered}/${total} (${(covered * 100 / total).toFixed(2)}%) is below ${floor}%`)
        }
        results[suffix][metricNames[metric]] = { covered, total, percent: covered * 100 / total, floor }
    }
}

console.log(JSON.stringify({ pass: true, results }, null, 2))
