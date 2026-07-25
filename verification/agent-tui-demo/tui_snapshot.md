# ProofGraph AI Agent TUI snapshot

```text
ProofGraph AI Agent TUI v1.0.1 · pg_4ff04e488efd0c1572a5e323 · finalized · integrity:PASS · focus:runs                  
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
┌ * RUNS ────────────────────┐ ┌ - GRAPH / AGENTS ──────────────────────────────┐ ┌ - INSPECTOR / APPROVALS ───────────┐
│›✓ pg_4ff04e488efd0c1572a5e…│ │›✓ triage [triage/system] a=1                   │ │Run: finalized · Integrity: PASS    │
│                            │ │ ✓ terminal-success [terminal/system] a=1       │ │Graph: graph_0135660d128012af r1    │
│                            │ │ ○ terminal-partial [terminal/system] a=0       │ │Ready: -                            │
│                            │ │ ○ terminal-failed [terminal/system] a=0        │ │Approvals: 0 · Failures: 0 · Events…│
│                            │ │ ✓ research-01 [research/researcher] a=1        │ │                                    │
│                            │ │ ✓ research-02 [research/researcher] a=1        │ │Node: triage                        │
│                            │ │ ✓ research-03 [research/researcher] a=1        │ │Title: Deterministic complexity and…│
│                            │ │ ✓ research-04 [research/researcher] a=1        │ │Kind/Role: triage/system            │
│                            │ │ ✓ research-05 [research/researcher] a=1        │ │Status: succeeded · Attempts: 1/1   │
│                            │ │ ✓ research-06 [research/researcher] a=1        │ │Risk/Model: low/inherit             │
│                            │ │ ✓ plan [plan/planner] a=1                      │ │Output: {"route":"human","assessmen…│
│                            │ │ ✓ develop [develop/developer] a=1              │ │                                    │
│                            │ │ ✓ verify [verify/verifier] a=1                 │ │                                    │
│                            │ │ ✓ synthesize [synthesize/synthesizer] a=1      │ │                                    │
│                            │ │ ✓ human-gate [human_approval/human] a=1        │ │                                    │
└────────────────────────────┘ └────────────────────────────────────────────────┘ └────────────────────────────────────┘
┌ - EVENTS ────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│#107 graph.node_ready system                                                                                          │
│#108 state.committed system                                                                                           │
│#109 tool.reserved synthesizer                                                                                        │
│#110 state.committed system                                                                                           │
│#111 graph.node_claimed synthesizer                                                                                   │
│#112 state.committed system                                                                                           │
│#113 tool.reserved synthesizer                                                                                        │
│#114 state.committed system                                                                                           │
│#115 graph.node_completed synthesizer                                                                                 │
│#116 graph.edge_activated system                                                                                      │
│#117 graph.node_ready system                                                                                          │
│#118 graph.run_finalized system                                                                                       │
│#119 state.committed system                                                                                           │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
Tab focus · j/k or arrows select · p pause/resume · s step · a approve · d deny · x abort · r refresh · q quit.
```
