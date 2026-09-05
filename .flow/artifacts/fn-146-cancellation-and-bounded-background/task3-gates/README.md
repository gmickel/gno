# Background turns and model leases

Product: 44cf2a1dbd937d97594baf9387374b4b16f98c63. Focused regression logs retained losslessly; counts overlap. Native lifecycle tests drive actual IPC with a controlled child; model-specific lease tests use mocked native ports. Physical model-residency comparison and final integrated CUDA/Metal QA remain separate evidence.

Queued background inference receives service after at most eight foreground inference completions. Metadata does not earn or reset credit. Earned service survives partition preparation gaps; the already-active inference is nonpreemptive. No reservation blocks foreground while background has no dispatchable native request.
