import sys
from pathlib import Path

# Ensure backend/ is on sys.path so backend modules are importable
# when pytest is invoked from the repo root (e.g. `pytest backend/tests/`).
sys.path.insert(0, str(Path(__file__).parent / "backend"))
