import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
for command in (
    [sys.executable, "app.py", "--check"],
    [sys.executable, "test_app.py"],
    ["node", "--check", "app.js"],
    ["node", "--check", "server.js"],
    ["node", "test_route.js"],
    ["node", "test_server.js"],
):
    subprocess.run(command, cwd=ROOT, check=True)
print("NAV_SMOKE_OK")
