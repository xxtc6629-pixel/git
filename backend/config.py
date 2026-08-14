"""Application configuration bootstrap.

The project-level .env file must be loaded before modules read environment
variables at import time (for example, the database path and session secret).
"""

from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = PROJECT_ROOT / ".env"

# Existing process environment variables take precedence over .env values.
load_dotenv(dotenv_path=ENV_PATH, override=False)
