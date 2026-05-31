FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG VITE_PRIVY_APP_ID
ARG VITE_PRIVY_CLIENT_ID
ENV VITE_PRIVY_APP_ID=$VITE_PRIVY_APP_ID
ENV VITE_PRIVY_CLIENT_ID=$VITE_PRIVY_CLIENT_ID
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
