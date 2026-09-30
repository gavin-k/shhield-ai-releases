FROM node:24.10.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential clang cmake pkg-config libssl-dev libdbus-1-dev libxcb1-dev \
    protobuf-compiler python3 ca-certificates git curl \
    && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain 1.96.1 --no-modify-path \
    && /opt/cargo/bin/rustup component add clippy \
    && chmod -R a+rX /opt/rustup /opt/cargo \
    && npm install --global pnpm@10.34.5 \
    && rm /tmp/rustup-init.sh
ENV PATH=/opt/cargo/bin:$PATH CARGO_HOME=/home/node/.cargo \
    CI=true PNPM_HOME=/home/node/.local/share/pnpm \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 DO_NOT_TRACK=1
USER node
WORKDIR /work
