#!/usr/bin/env python3
"""Affiche le centre « x y » du premier nœud uiautomator dont le texte vaut argv[2]."""
import re, sys
s = open(sys.argv[1], encoding="utf8", errors="ignore").read()
want = sys.argv[2]
for node in re.finditer(r"<node [^>]*>", s):
    n = node.group(0)
    t = re.search(r'text="([^"]*)"', n)
    d = re.search(r'content-desc="([^"]*)"', n)
    if (t and t.group(1).strip() == want) or (d and d.group(1).strip() == want):
        b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
        if b:
            x1, y1, x2, y2 = map(int, b.groups())
            print((x1 + x2) // 2, (y1 + y2) // 2)
            break
