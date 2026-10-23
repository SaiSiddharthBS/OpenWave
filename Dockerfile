FROM python:3.12-slim

# yt-dlp needs a JavaScript runtime to solve YouTube's player challenges.
COPY --from=denoland/deno:bin-2.9.7 /deno /usr/local/bin/deno

WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY openwave ./openwave
RUN pip install --no-cache-dir . && useradd --create-home openwave
USER openwave

EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8787/api/health')"
CMD ["openwave", "--no-browser", "--host", "0.0.0.0", "--port", "8787"]
