FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends     ca-certificates curl tini xvfb x11vnc x11-utils openbox novnc websockify socat     fonts-dejavu-core libxtst6 libxrender1 libxi6 libasound2 libgtk-3-0     && rm -rf /var/lib/apt/lists/*
# Official Linux x64 Stable installer downloaded 2026-09-30 over HTTPS.
ARG IB_GATEWAY_SHA256=6c55775003698accc78b52df49092128143f1360fdef4f52cce977a1d377d28f
RUN --mount=type=bind,source=.build/ibgateway-installer.sh,target=/tmp/ibgateway-installer.sh,ro test -n "$IB_GATEWAY_SHA256"     && echo "$IB_GATEWAY_SHA256  /tmp/ibgateway-installer.sh" | sha256sum -c -      && sh /tmp/ibgateway-installer.sh -q -dir /opt/ibgateway      && useradd --uid 10002 --create-home --shell /bin/bash ibgateway     && mkdir -p /home/ibgateway/Jts     && chown -R ibgateway:ibgateway /home/ibgateway
RUN sed -i -e '/^-Xm[sx]/d' -e 's/^-XX:ParallelGCThreads=.*/-XX:ParallelGCThreads=2/' -e 's/^-XX:ConcGCThreads=.*/-XX:ConcGCThreads=1/' /opt/ibgateway/ibgateway.vmoptions     && printf '\n-Xms128m\n-Xmx768m\n' >> /opt/ibgateway/ibgateway.vmoptions
COPY deploy/gateway-start.sh /usr/local/bin/gateway-start
RUN chmod 755 /usr/local/bin/gateway-start
ENV HOME=/home/ibgateway DISPLAY=:1 LANG=C.UTF-8
WORKDIR /home/ibgateway
USER ibgateway
EXPOSE 6080 5001 5002
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s     CMD curl --fail --silent http://127.0.0.1:6080/vnc.html >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/gateway-start"]
