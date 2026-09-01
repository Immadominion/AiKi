# Agent Advantage Report

Three real tasks, each run once by hand and once through AiKi, as required by the
Build the Era submission.

```
python3 run.py > evidence.json
```

It makes live calls to https://www.useaiki.xyz and to a public BNB Smart Chain
RPC. Nothing is mocked and nothing is estimated: the timings are wall clock
around the real calls and every response is saved whole in `evidence.json`.

| Task | Category | The finding |
|---|---|---|
| 1 | security | "Liquidation Desk" (agent 310108) returns byte-identical bytes to every input. The check most people run, one GET returning 200, reads it as a working agent. AiKi refuses the sale. |
| 2 | discovery | "Protect my loan from liquidation" matches 73 agents. 54 are static pages. They are excluded and counted rather than quietly dropped. |
| 3 | trading | A PancakeSwap v3 grid range check. Both arms independently produced tick -65298 and band [-65300, -65290], which is the strongest thing that can be said for the agent: its answer was reproducible by hand. |

Two of the three manual arms reached the wrong answer. That is the result. On a
single check the time difference is seconds and not the point; the cost of doing
this by hand is hiring a static page with money behind it.

Ticks move, so a re-run of task 3 will show a different tick and the same
agreement between the arms, because both are read within the same second.
