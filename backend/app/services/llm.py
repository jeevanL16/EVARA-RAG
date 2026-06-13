"""Gemini LLM service — Groq API (llama-3.3-70b-versatile)."""
import logging
from typing import List, Optional
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

from app.core.config import settings
from app.services.retriever import RetrievedChunk

logger = logging.getLogger(__name__)

_client = None

def get_client():
    global _client
    if _client is None and settings.GROQ_API_KEY:
        from groq import Groq
        _client = Groq(api_key=settings.GROQ_API_KEY)
    return _client


SYSTEM_NORMAL = """You are EVARA, an evidence-driven document analysis assistant.
RULES:
- Answer ONLY from the provided document context below.
- Never use training knowledge or make up facts.
- Every claim must reference a source chunk.
- If the answer is not in the context, say: "This information is not found in the uploaded documents."
- Be precise, structured, and cite [filename | page N] inline."""

SYSTEM_SECURITY = """You are EVARA Security Analyst, an evidence-driven cybersecurity analysis assistant.
RULES:
- Analyze ONLY from the provided scan/report context below.
- Never invent CVEs, CVSS scores, or vulnerabilities not present in the data.
- Structure findings by: Asset → Severity → Finding → Evidence → Recommendation.
- Cite [filename | page N] for every finding.
- If information is absent, state it explicitly."""


def build_prompt(query: str, context: str, mode: str, analysis_type: str = "query") -> str:
    system = SYSTEM_SECURITY if mode == "security" else SYSTEM_NORMAL

    if analysis_type == "auto_analysis":
        if mode == "security":
            task = """Perform a complete security analysis. Extract and organize:
1. **Assets & Hosts** - IPs, hostnames, OS
2. **Open Ports & Services** - port/protocol/service/version
3. **Vulnerabilities & CVEs** - ID, CVSS, severity
4. **Risk Assessment** - critical/high/medium/low counts
5. **OWASP/MITRE Mappings** - if present
6. **Recommendations** - prioritized mitigations
Only report what is present in the context."""
        else:
            task = """Generate a comprehensive document analysis:
1. **Executive Summary** - 3-5 sentences
2. **Key Findings** - bullet points
3. **Important Concepts** - terms and definitions found
4. **Main Topics** - structured outline
5. **Conclusions** - what the document concludes
6. **Notable Sections** - important sections with citations
Cite [filename | page N] throughout."""
    else:
        task = f"User Question: {query}"

    return f"{task}\n\n=== DOCUMENT CONTEXT ===\n{context}"


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    retry=retry_if_exception_type(Exception),
    reraise=False,
)
def _call_groq(system: str, prompt: str) -> Optional[str]:
    client = get_client()
    if not client:
        return None
    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        max_tokens=4096,
        temperature=0.1,
    )
    return response.choices[0].message.content


def generate_answer(
    query: str,
    chunks: List[RetrievedChunk],
    context: str,
    mode: str = "normal",
    analysis_type: str = "query",
) -> dict:
    system = SYSTEM_SECURITY if mode == "security" else SYSTEM_NORMAL
    prompt = build_prompt(query, context, mode, analysis_type)

    try:
        text = _call_groq(system, prompt)
        if text:
            return {"answer": text, "source": "llm", "error": None}
    except Exception as e:
        logger.warning(f"Groq failed: {e}")

    # Graceful degradation
    fallback = "**⚠ LLM unavailable. Showing retrieved evidence directly:**\n\n"
    for i, c in enumerate(chunks[:6], 1):
        fallback += f"**[{i}] {c.filename} | Page {c.page_number} | Score: {c.score:.3f}**\n{c.text[:600]}\n\n"
    return {"answer": fallback, "source": "rag_fallback", "error": "LLM API unavailable"}