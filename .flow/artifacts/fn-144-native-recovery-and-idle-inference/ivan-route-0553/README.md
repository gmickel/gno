# Ivan existing-route inspection

Date: 2026-09-05. Read-only investigation; no product, Git, Flow, SSH configuration, service, key, or privilege changes. No new native inference.

Local process inspection found an existing SSH destination `heimdall` alongside existing Ivan connections. Only destination/count information was emitted; remote command bodies and credentials were not printed. Local `ssh -G` reported `gordon@heimdall:22` and `gordon@ivan:22`, no configured ProxyJump/ProxyCommand or ControlMaster. No user SSH config was present. The expected `/home/gordon/work/manager` checkout was absent; no speculative replacement host search was performed.

The local Tailscale peer state identified the existing online Heimdall MacBook at `100.70.148.81` and Ivan at `100.107.76.61`. Peer state alone does not prove SSH availability. No advertised Ivan SSH host keys or SSH capability established a distinct Tailscale SSH route.

At **2026-09-05 05:53:15 UTC**, one host-authorized jump probe ran:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 \
  -o ControlMaster=auto -o ControlPersist=600 \
  -o ControlPath=/home/gordon/.cache/agent-tmp/gno-fn144-childcapture/ivan-via-heimdall.sock \
  -J heimdall ivan 'date -u +%Y-%m-%dT%H:%M:%SZ; uname -s'
```

Observed exit255: `Connection closed by UNKNOWN port 65535`. No remote output, artifact retrieval, or successful persistent Ivan connection. That error alone does not distinguish a forwarding restriction from an Ivan connection closure.

One subsequent first-hop-only command used BatchMode, strict existing host-key checking, and a five-second connection timeout: `ssh heimdall 'uname -s'`. It returned `Darwin`, exit0. Existing Heimdall SSH access therefore works, while the tested jump route to Ivan did not.

Stopped further Ivan probes. No agent forwarding, access provisioning, host-key acceptance, service restart, process kill, or unrelated connection mutation. Completed QA receipts remain on Ivan; no inference retries occurred. The pending user Remote Login question remains relevant.
