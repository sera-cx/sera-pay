# Demo Setup Guide for Multi-Currency SeraPay

This guide helps you set up the multi-currency SeraPay enhancement for demo purposes.

## Quick Demo Setup (No Database Required)

For a quick demo without full database setup, you can test the FX and location detection APIs independently:

### 1. Set Minimal Environment Variables

Create a `.env` file with these minimum values:

```bash
NODE_ENV=development
PORT=3000
SERA_NETWORK=mainnet
POLICY_PRESET=standard
```

### 2. Test FX Service Directly

```bash
cd lib/sera-mcp
node dist/cli.js fx USD MYR
```

### 3. Test Location Detection

The location detection service uses a free API and doesn't require database setup.

## Full Setup (With Database)

For complete functionality including payment creation:

### 1. Set Up Database

You need a PostgreSQL database. Options:
- Local PostgreSQL installation
- Docker: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:15`
- Cloud: Supabase, Neon, Railway

### 2. Configure .env

Copy `.env.example` to `.env` and set:

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/serapay
SESSION_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">
SERA_CONFIG_ENCRYPTION_KEY=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">
```

### 3. Run Migrations

```bash
pnpm db:generate
pnpm db:migrate
```

### 4. Start Server

```bash
pnpm run dev
```

## Demo Script

Use this script to demonstrate the multi-currency features:

```bash
# Terminal 1: Start the server
pnpm run dev

# Terminal 2: Run demo commands
# Test FX rate
curl http://localhost:3000/api/fx/rate?base=USD&quote=MYR

# Test currency detection
curl http://localhost:3000/api/fx/detect-currency

# Test location detection
curl http://localhost:3000/api/fx/location

# Test supported currencies
curl http://localhost:3000/api/fx/currencies
```

## Key Features to Demo

1. **Automatic Currency Detection**: Show how the system detects customer currency from IP
2. **Real-time FX Rates**: Display live rates between currency pairs
3. **Multi-Currency Support**: Show 40+ supported currencies
4. **Auto-Conversion**: Demonstrate automatic conversion to merchant's preferred currency

## Video Demo Flow

1. **Introduction**: Explain the multi-currency enhancement
2. **Currency Detection**: Show location detection API
3. **FX Rates**: Demonstrate rate fetching between USD/MYR
4. **Supported Currencies**: Show the list of 40+ currencies
5. **Payment Creation**: Show the multi-currency payment endpoint
6. **Conclusion**: Explain benefits for Sera ecosystem

## Troubleshooting

**Database connection error**: Ensure PostgreSQL is running and DATABASE_URL is correct

**Sera MCP not working**: Ensure the MCP server is built: `cd lib/sera-mcp && npm run build`

**Location detection failing**: Check internet connectivity (uses ipapi.co)

**Port already in use**: Change PORT in .env or kill the process using port 3000
