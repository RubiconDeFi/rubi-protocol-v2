# Rubicon Protocol v2

```shell
npm run test # run the test suite
npx run compile # compile the smart contracts
```

# Room for Improvement

Note if no issue linked, then could be needed:
- RubiconMarket needs an added, optional time limit for offers, after which an offer cannot be bought or taken and instead can only be cancelled (* needs an issue *). This will require some investigation regarding how to clear out "expired" orders from the market list.
- Wrapper function to allow for shorting and the use of desired leverage (* needs an issue *).
- High-level BathHouse that can oversee [1] *core*, blue-chip pools (v2-core cToken fork) [2] Fuse pool (basket of other pools - *NOT included in v2-core*), and [3] Bath Token X (arbitrary pools with open-ended definitions and uses - *NOT included in v2-core*). Regarding 2 and 3, noting them here because we need to keep the door open for their inclusion in the system in BathHouse. BathHouse should at as a convenient entry point through which anyone can query relevant Pools information across all types.
- Need to semantically wrap all cToken pools to be Bath Tokens - *this is done already at deployment as a solution* => Explore the idea of a function that automatically spawns new Bath Tokens; this could be more convenient that manual deployment and could also not be needed at all. Moreover some sort of verification that new BathTokens added into the system fit the semantic schema we expect (e.g. "bathUSDC") could be helpful.
