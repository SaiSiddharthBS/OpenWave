FROM python:3.12-slim

# yt-dlp needs a JavaScript runtime to solve YouTube's player challenges.
COPY --from=denoland/deno:bin-2.9.7 /deno /usr/local/bin/deno

WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY openwave ./openwave
RUN pip install --no-cache-dir . && useradd --create-home openwave && mkdir /data && chown openwave /data
USER openwave

# Profiles, libraries and listening history live here: keep it on a volume.
ENV OPENWAVE_DATA=/data
VOLUME /data

EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8787/api/health')"
CMD ["openwave", "--no-browser", "--host", "0.0.0.0", "--port", "8787"]
