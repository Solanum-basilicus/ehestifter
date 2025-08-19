import bleach
from bs4 import BeautifulSoup

ALLOWED_TAGS = ["p","br","hr","span","div","b","strong","i","em","u","code","pre","blockquote",
                "ul","ol","li","h1","h2","h3","h4","a","img"]
ALLOWED_ATTRS = {"a":["href","title"], "img":["src","alt"], "*":["class"]}
ALLOWED_PROTOCOLS = ["http","https","mailto","data"]

def sanitize_description_html(html: str) -> str:
    if not html:
        return ""
    cleaned = bleach.clean(html, tags=ALLOWED_TAGS, attributes=ALLOWED_ATTRS,
                           protocols=ALLOWED_PROTOCOLS, strip=True)
    soup = BeautifulSoup(cleaned, "html.parser")
    for img in soup.find_all("img"):
        src = (img.get("src") or "").strip()
        if not src.startswith("data:"):
            img.decompose()
    for a in soup.find_all("a"):
        a["target"] = "_blank"
        a["rel"] = "noopener noreferrer nofollow"
    return str(soup)
