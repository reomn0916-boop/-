"""Windows用 .exe の入口（PyInstaller用）。"""
import sys

from sekisan.__main__ import main

sys.exit(main())
