# One image for both roles: the arena pod runs `node arena.js`,
# the snake pods run `node snake.js` (the arena sets the command).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY src/ ./
USER node
EXPOSE 8080
CMD ["node", "arena.js"]
