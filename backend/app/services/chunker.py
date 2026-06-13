"""
Semantic chunking service.
Size: 700–1000 chars. Overlap: 150–200 chars.
Preserves: paragraphs, headings, tables, lists.
Blocks: garbage, binary blobs, corrupted OCR.
"""
import re
import logging
from typing import List, Dict, Any
from dataclasses import dataclass, field

from app.services.parser import ParsedDocument, ParsedPage, is_garbage_chunk, clean_text
from app.core.config import settings

logger = logging.getLogger(__name__)


@dataclass
class Chunk:
    chunk_id: str
    doc_id: str
    filename: str
    text: str
    page_number: int
    chunk_index: int
    char_start: int
    char_end: int
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_chroma_metadata(self) -> Dict[str, Any]:
        return {
            "doc_id": self.doc_id,
            "filename": self.filename,
            "page_number": self.page_number,
            "chunk_index": self.chunk_index,
            "char_start": self.char_start,
            "char_end": self.char_end,
            **{k: str(v)[:200] for k, v in self.metadata.items()},
        }


class SmartChunker:
    def __init__(
        self,
        chunk_size: int = None,
        overlap: int = None,
    ):
        self.chunk_size = chunk_size or settings.CHUNK_SIZE
        self.overlap = overlap or settings.CHUNK_OVERLAP

    def chunk_document(self, doc: ParsedDocument, doc_id: str) -> List[Chunk]:
        """Chunk all pages in a parsed document."""
        all_chunks: List[Chunk] = []
        global_chunk_idx = 0

        for page in doc.pages:
            page_chunks = self._chunk_page(page, doc_id, doc.filename, global_chunk_idx)
            all_chunks.extend(page_chunks)
            global_chunk_idx += len(page_chunks)

        logger.info(f"Chunked {doc.filename}: {len(all_chunks)} chunks from {doc.total_pages} pages")
        return all_chunks

    def _chunk_page(
        self,
        page: ParsedPage,
        doc_id: str,
        filename: str,
        start_idx: int,
    ) -> List[Chunk]:
        """Split a single page into overlapping semantic chunks."""
        text = page.text
        if not text or is_garbage_chunk(text):
            return []

        # Split into semantic units (paragraphs / sections)
        units = self._split_semantic_units(text)
        chunks: List[Chunk] = []
        current_text = ""
        current_start = 0
        char_pos = 0
        chunk_local_idx = 0

        for unit in units:
            unit_len = len(unit)

            # If adding this unit would exceed chunk_size, flush
            if current_text and len(current_text) + unit_len > self.chunk_size:
                chunk = self._make_chunk(
                    current_text, doc_id, filename, page,
                    start_idx + chunk_local_idx, current_start, char_pos
                )
                if chunk:
                    chunks.append(chunk)
                    chunk_local_idx += 1

                # Overlap: keep last N chars of current_text
                overlap_text = current_text[-self.overlap:] if len(current_text) > self.overlap else current_text
                current_text = overlap_text + "\n" + unit
                current_start = char_pos - len(overlap_text)
            else:
                if current_text:
                    current_text += "\n" + unit
                else:
                    current_text = unit
                    current_start = char_pos

            char_pos += unit_len + 1  # +1 for newline separator

        # Flush remaining
        if current_text:
            chunk = self._make_chunk(
                current_text, doc_id, filename, page,
                start_idx + chunk_local_idx, current_start, char_pos
            )
            if chunk:
                chunks.append(chunk)

        return chunks

    def _make_chunk(
        self,
        text: str,
        doc_id: str,
        filename: str,
        page: ParsedPage,
        chunk_idx: int,
        char_start: int,
        char_end: int,
    ) -> "Chunk | None":
        text = clean_text(text)
        if is_garbage_chunk(text):
            return None
        chunk_id = f"{doc_id}__p{page.page_number}__c{chunk_idx}"
        return Chunk(
            chunk_id=chunk_id,
            doc_id=doc_id,
            filename=filename,
            text=text,
            page_number=page.page_number,
            chunk_index=chunk_idx,
            char_start=max(0, char_start),
            char_end=char_end,
            metadata=page.metadata,
        )

    def _split_semantic_units(self, text: str) -> List[str]:
        """
        Split text into paragraphs / headings / list items.
        Preserves table rows, bullet points, numbered lists.
        """
        # Normalize line endings
        text = text.replace("\r\n", "\n").replace("\r", "\n")

        # Split on double newlines (paragraph boundary) first
        rough_blocks = re.split(r'\n{2,}', text)
        units = []

        for block in rough_blocks:
            block = block.strip()
            if not block:
                continue
            # If block is still very large, split further on single newlines
            if len(block) > self.chunk_size * 1.5:
                lines = block.split("\n")
                sub = ""
                for line in lines:
                    if len(sub) + len(line) > self.chunk_size:
                        if sub.strip():
                            units.append(sub.strip())
                        sub = line
                    else:
                        sub = (sub + "\n" + line).strip()
                if sub.strip():
                    units.append(sub.strip())
            else:
                units.append(block)

        return [u for u in units if u.strip()]


chunker = SmartChunker()
