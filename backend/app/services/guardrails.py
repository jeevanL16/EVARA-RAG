"""
Input and output guardrails.
Input: Detect prompt injection, jailbreaks, OOB attacks.
Output: Verify claims against retrieved chunks, block hallucinations.
"""
import re
import logging
from typing import List, Tuple, Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────
# INPUT GUARDRAILS
# ─────────────────────────────────────────────────────────────

INJECTION_PATTERNS = [
    # Classic prompt injection
    r"ignore (all |the )?(previous|above|prior|system) (instructions?|prompts?|context)",
    r"disregard (all |the )?(previous|above|prior|system) (instructions?|prompts?|context)",
    r"forget (everything|all) (you know|above|previous)",
    r"you are now (a |an )?(?!evara)",
    r"act as (a |an )?(new|different|unrestricted|jailbroken)",
    r"pretend (you are|to be) (a |an )?(?!evara)",
    r"new persona",
    r"jailbreak",
    r"DAN (mode|prompt)",
    r"developer mode",
    r"override (safety|guardrail|restriction)",
    # Instruction injection via document-like phrasing
    r"system\s*:\s*(you|ignore|forget|disregard)",
    r"\[SYSTEM\]",
    r"\[INST\].*forget",
    r"<\|system\|>",
    r"</?(sys|system|SYS)>",
    # Exfiltration attempts
    r"(print|show|reveal|output|return|display) (your |the )?(system prompt|instructions|context|memory)",
    r"what (are|were) your (instructions|system prompt|initial prompt)",
    # OOB / out-of-scope attacks
    r"access (the |my )?(database|file system|server|API|internet)",
    r"execute (code|command|script|sql|shell)",
    r"run (this )?(code|script|command)",
]

COMPILED_INJECTION = [re.compile(p, re.IGNORECASE | re.DOTALL) for p in INJECTION_PATTERNS]

MAX_QUERY_LENGTH = 2000


def check_input(query: str) -> Tuple[bool, Optional[str]]:
    """
    Returns (is_safe, reason).
    is_safe=False means the query should be blocked.
    """
    if not query or not query.strip():
        return False, "Empty query."

    if len(query) > MAX_QUERY_LENGTH:
        return False, f"Query too long (max {MAX_QUERY_LENGTH} chars)."

    for pattern in COMPILED_INJECTION:
        if pattern.search(query):
            logger.warning(f"Input guardrail triggered: {pattern.pattern[:50]}")
            return False, "Query contains disallowed content (possible prompt injection or out-of-scope request)."

    return True, None


# ─────────────────────────────────────────────────────────────
# OUTPUT GUARDRAILS
# ─────────────────────────────────────────────────────────────

# Phrases that typically indicate hallucination or unsupported claims
HALLUCINATION_SIGNALS = [
    r"as (of my knowledge|i know|i recall|i remember)",
    r"based on (my training|general knowledge|what i know)",
    r"i (believe|think|assume|suppose) (that )?(?!the uploaded|the document|the file)",
    r"typically|usually|generally|commonly|often|in most cases",  # generic claims
    r"it (is|was) (widely|generally|commonly) (known|accepted|believed)",
]

COMPILED_HALLUCINATION = [re.compile(p, re.IGNORECASE) for p in HALLUCINATION_SIGNALS]


def check_output(response: str, context_texts: List[str]) -> Tuple[str, List[str]]:
    """
    Check LLM response for potential hallucinations.
    Returns (cleaned_response, warnings).
    """
    warnings = []

    for pattern in COMPILED_HALLUCINATION:
        if pattern.search(response):
            warnings.append(
                "Response may contain a claim not directly supported by the uploaded documents."
            )
            break

    # Check if response contains any content that's clearly outside retrieved context
    # Simple heuristic: if no sentence from response overlaps meaningfully with context
    if context_texts and len(response) > 100:
        context_blob = " ".join(context_texts).lower()
        response_sentences = [s.strip() for s in re.split(r'[.!?]', response) if len(s.strip()) > 30]
        grounded_count = 0
        for sent in response_sentences[:10]:
            # Check if key words from this sentence appear in context
            words = set(re.findall(r'\b\w{5,}\b', sent.lower()))
            overlap = sum(1 for w in words if w in context_blob)
            if words and overlap / len(words) > 0.25:
                grounded_count += 1
        if response_sentences and grounded_count / len(response_sentences[:10]) < 0.2:
            warnings.append(
                "Warning: Response content may not be fully grounded in the uploaded documents."
            )

    return response, warnings
