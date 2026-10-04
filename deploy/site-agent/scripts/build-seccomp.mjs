#!/usr/bin/env node
// Baseline: https://raw.githubusercontent.com/moby/moby/docker-v29.8.1/vendor/github.com/moby/profiles/seccomp/default.json
// SPDX-License-Identifier: Apache-2.0 (Moby baseline); additions are scoped to this service.
import { readFileSync, writeFileSync } from "node:fs";

const baseline = new URL("../security/seccomp-docker-29.8.1.json", import.meta.url);
const policy = JSON.parse(readFileSync(baseline, "utf8"));
if (policy.defaultAction !== "SCMP_ACT_ERRNO" || policy.defaultErrnoRet !== 1)
  throw new Error("Unexpected Docker deny-by-default baseline");
const allow = (name, args = [], comment) => policy.syscalls.push({
  names: [name], action: "SCMP_ACT_ALLOW", includes: { arches: ["amd64"] }, args, comment,
});
const equal = (index, value) => ({ index, value, op: "SCMP_CMP_EQ" });

// Preserve all original rules. Only creation of a fresh user+mount namespace is added;
// no setns, clone3, host capability, BPF, ptrace or general namespace exception is added.
for (const flags of [0x10020000, 0x30020000, 0x18020000, 0x38020000, 0x78020000])
  allow("clone", [{ index: 0, value: 0x7e020000, valueTwo: flags, op: "SCMP_CMP_MASKED_EQ" }],
    "Bubblewrap: NEWUSER+NEWNS, optionally PID/IPC/NET; remaining namespace flags prohibited");
allow("unshare", [equal(0, 0x10000000)], "Bubblewrap nested user namespace only");

// Exact flags used by bubblewrap's private mount tree setup. AppArmor additionally
// restricts mount types and targets; the outer container has no capabilities.
for (const flags of [0x8c000, 6, 14, 10, 0xd000, 0xc0edd000, 0x4c000, 0x9000])
  allow("mount", [equal(3, flags)], "Bubblewrap mount-tree setup; exact flag value");
const optionalRemount = 1 | 4 | 8 | 1024 | 2048 | 0x200000 | 0x2000000;
allow("mount", [{ index: 3, value: (0xffffffff ^ optionalRemount) >>> 0,
  valueTwo: 0x9022, op: "SCMP_CMP_MASKED_EQ" }],
"Bind-remount requires SILENT+BIND+REMOUNT+NOSUID; optional read-only/nodev/noexec/time flags");
allow("umount2", [equal(1, 2)], "Bubblewrap MNT_DETACH only");
allow("pivot_root", [], "Bubblewrap private root; target constrained by AppArmor");
writeFileSync(new URL("../security/seccomp-site-agent.json", import.meta.url), JSON.stringify(policy, null, 2) + "\n");
