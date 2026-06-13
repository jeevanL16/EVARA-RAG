from pydantic_settings import BaseSettings
from pathlib import Path
import os


class Settings(BaseSettings):
    # API
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "")
    GROQ_MODEL: str = "llama-3.3-70b-versatile"
    # Storage
    UPLOAD_DIR: Path = Path("./data/uploads")
    CHROMA_DIR: Path = Path("./data/chroma")
    INDEX_DIR: Path = Path("./data/index")

    # Chunking
    CHUNK_SIZE: int = 850
    CHUNK_OVERLAP: int = 175
    MAX_CHUNKS_PER_DOC: int = 10000

    # Retrieval
    TOP_K_DENSE: int = 20
    TOP_K_BM25: int = 20
    TOP_K_RERANK: int = 8
    CONTEXT_WINDOW: int = 6000

    # Embeddings
    EMBEDDING_MODEL: str = "sentence-transformers/all-MiniLM-L6-v2"
    EMBEDDING_DIM: int = 384

    # Collections
    NORMAL_COLLECTION: str = "evara_normal"
    SECURITY_COLLECTION: str = "evara_security"

    # App
    MAX_FILE_SIZE_MB: int = 100
    ALLOWED_EXTENSIONS_NORMAL: list = [
        ".pdf", ".docx", ".txt", ".md", ".csv", ".json", ".html", ".xml", ".zip"
    ]
    ALLOWED_EXTENSIONS_SECURITY: list = [
        ".xml", ".nessus", ".csv", ".json", ".pdf", ".txt", ".md"
    ]

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()

# Ensure directories exist
for d in [settings.UPLOAD_DIR, settings.CHROMA_DIR, settings.INDEX_DIR]:
    d.mkdir(parents=True, exist_ok=True)
