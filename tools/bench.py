#!/usr/bin/env python3
"""CPU time (user + system, all threads) of commands, from wait4's rusage: microseconds, not the 10 ms of time(1).

  python3 -I tools/bench.py RUNS -- cmd1 args ... -- cmd2 args ...

Runs the commands interleaved RUNS times and prints, for each, the median, the mean, the trimmed mean (2 lowest and
2 highest dropped) and the min of its CPU time in ms. stdout and stderr of the commands are discarded.
"""
import os
import statistics
import subprocess
import sys


def cpu_ms(cmd):
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    _, status, ru = os.wait4(p.pid, 0)
    if status != 0:
        raise SystemExit(f"exit status {status}: {' '.join(cmd)}")
    return (ru.ru_utime + ru.ru_stime) * 1000.0


def trimmed(xs):
    s = sorted(xs)
    return statistics.mean(s[2:-2]) if len(s) > 4 else statistics.mean(s)


def main():
    runs = int(sys.argv[1])
    cmds, cur = [], None
    for a in sys.argv[2:]:
        if a == '--':
            cur = []
            cmds.append(cur)
        else:
            cur.append(a)
    times = [[] for _ in cmds]
    for _ in range(runs):
        for k, c in enumerate(cmds):
            times[k].append(cpu_ms(c))
    for c, t in zip(cmds, times):
        print(f"median {statistics.median(t):7.1f}  mean {statistics.mean(t):7.1f}  trim {trimmed(t):7.1f}  min {min(t):7.1f}  sd {statistics.pstdev(t):5.1f}  {' '.join(c)[-70:]}")


if __name__ == '__main__':
    main()
