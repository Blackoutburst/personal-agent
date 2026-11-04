#!/usr/bin/env python3
"""Fills the prompt templates (prompts/*.txt) with a character's values from character.json.

  prompts.py <character dir>    writes <dir>/prompt-1-base.txt … prompt-5-outfits-special.txt"""
import json, os, re, sys

kit = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
root = os.path.abspath(sys.argv[1])
values = json.load(open(os.path.join(root, 'character.json')))['prompt']
for name in sorted(os.listdir(os.path.join(kit, 'prompts'))):
    text = open(os.path.join(kit, 'prompts', name)).read()
    missing = sorted(set(re.findall(r'\{\{(\w+)\}\}', text)) - set(values))
    if missing: sys.exit(f'{name}: character.json "prompt" is missing {", ".join(missing)}')
    text = re.sub(r'\{\{(\w+)\}\}', lambda m: values[m.group(1)], text)
    open(os.path.join(root, 'prompt-' + name), 'w').write(text)
    print('wrote', 'prompt-' + name)
