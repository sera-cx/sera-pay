# Video Demo Guide for Multi-Currency SeraPay

This guide provides a complete script and instructions for recording a demo video of the multi-currency SeraPay enhancement.

## Video Demo Script

### Introduction (0:00 - 0:30)

**Visual:** Title screen "Multi-Currency SeraPay Enhancement"

**Narrator:**
"Today I'm going to demonstrate the multi-currency payment enhancement for SeraPay. This integration enables merchants to accept payments in customer's local currency automatically using Sera's FX infrastructure, supporting 40+ currencies worldwide."

### Demo 1: Standalone Demo Script (0:30 - 2:00)

**Visual:** Terminal window showing the demo script running

**Action:** Run `npx tsx demo.ts`

**Narrator:**
"Let me start by running our standalone demo script that showcases all the multi-currency features without needing a database or full server setup."

**Visual:** Demo output showing supported currencies

**Narrator:**
"First, you can see we support 40+ currencies including USD, EUR, GBP, JPY, SGD, MYR, and many more. This global coverage is essential for cross-border commerce."

### Demo 2: FX Rate Display (2:00 - 3:00)

**Visual:** Demo output showing FX rate between USD and MYR

**Narrator:**
"Here's a real-time FX rate between USD and Malaysian Ringgit. The system shows the current rate, 24-hour change percentage, and timestamp. This data comes directly from Sera's multi-source pricing infrastructure."

### Demo 3: Currency Conversion Quote (3:00 - 4:00)

**Visual:** Demo output showing conversion quote for 100 USD to MYR

**Narrator:**
"When a customer wants to pay 100 USD, the system provides an instant quote showing they'll receive 465 MYR at the current rate, with transparent fee information displayed in basis points."

### Demo 4: Best FX Deals (4:00 - 5:00)

**Visual:** Demo output showing best deals with 25+ bps spread

**Narrator:**
"The system continuously monitors for the best FX deals across currency pairs. Here you can see USD/MYR at 30 basis points and USD/SGD at 25 basis points, helping merchants optimize their conversion costs."

### Demo 5: Spread Radar (5:00 - 6:00)

**Visual:** Demo output showing spread radar for multiple currencies

**Narrator:**
"The spread radar provides real-time visibility into FX spreads across multiple currencies, helping merchants make informed decisions about when to convert and which routes offer the best pricing."

### Demo 6: Location-Based Currency Detection (6:00 - 7:00)

**Visual:** Demo output showing currency detection for Malaysia and Singapore

**Narrator:**
"One of the most powerful features is automatic currency detection based on customer location. For example, customers from Malaysia are automatically detected and offered MYR pricing, while Singapore customers see SGD pricing."

### Demo 7: Stablecoin Selection (7:00 - 8:00)

**Visual:** Demo output showing stablecoins for MYR

**Narrator:**
"The system automatically selects the optimal stablecoin for each currency. For Malaysian Ringgit, it uses MYR stablecoin, ensuring efficient on-chain settlement."

### Demo 8: Currency Formatting (8:00 - 8:30)

**Visual:** Demo output showing formatted currency amounts

**Narrator:**
"Proper currency formatting is handled automatically, displaying amounts with the correct symbols and decimal places for each currency - USD with dollar sign, MYR with RM, EUR with euro symbol, and so on."

### Demo 9: Conversion Calculations (8:30 - 9:00)

**Visual:** Demo output showing conversion calculation

**Narrator:**
"Conversion calculations are performed accurately, ensuring customers and merchants always know exactly how much they're sending and receiving in their respective currencies."

### Technical Implementation Overview (9:00 - 11:00)

**Visual:** Code editor showing key files

**Narrator:**
"Let me show you the technical implementation. We've added several new components to SeraPay:"

**Visual:** Show `server/sera-fx-service.ts`

**Narrator:**
"The Sera FX Service interfaces with Sera MCP for all FX operations, including rate fetching, quotes, and deal detection. It includes a mock mode for demo purposes when the API is unavailable."

**Visual:** Show `server/location-detection.ts`

**Narrator:**
"The Location Detection Service uses IP-based geolocation to automatically detect customer currency, with caching for performance."

**Visual:** Show `server/fx-routes.ts`

**Narrator:**
"FX API routes provide endpoints for rates, quotes, currencies, and location detection, making the functionality accessible to the frontend."

**Visual:** Show `server/payment-routes.ts` - the new multi-currency endpoint

**Narrator:**
"The new multi-currency payment endpoint automatically detects customer currency, fetches FX rates, and converts to the merchant's preferred settlement currency."

**Visual:** Show database schema changes

**Narrator:**
"We've enhanced the database schema to track customer currency, FX rates used, conversion status, and settlement currency for every transaction."

### Frontend Components (11:00 - 12:00)

**Visual:** Show `client/src/lib/fx-api.ts` and `client/src/components/FxRateDisplay.tsx`

**Narrator:**
"On the frontend, we've created an FX API client and a real-time FX rate display component that shows live rates and conversion previews during checkout."

### Integration with Sera Ecosystem (12:00 - 13:00)

**Visual:** Show Sera MCP integration

**Narrator:**
"This integration leverages Sera's existing MCP infrastructure, making it seamless to add multi-currency capabilities to any Sera-powered application. The system supports both mainnet and testnet environments."

### Benefits for Sera (13:00 - 14:00)

**Visual:** Summary slide showing key benefits

**Narrator:**
"This enhancement provides significant value to the Sera ecosystem:"

- "Reduces FX friction for cross-border merchants"
- "Enables automatic currency conversion at optimal rates"
- "Supports 40+ currencies for global reach"
- "Transparent pricing with real-time FX display"
- "Seamless integration with existing Sera infrastructure"
- "Demonstrates practical use of Sera's agent platform"

### Conclusion (14:00 - 15:00)

**Visual:** Summary of what was built

**Narrator:**
"In summary, we've successfully implemented a production-ready multi-currency payment enhancement for SeraPay that:"

- "Automatically detects customer currency from location"
- "Provides real-time FX rates from Sera's infrastructure"
- "Enables automatic conversion to merchant's preferred currency"
- "Supports 40+ currencies with proper stablecoin selection"
- "Includes comprehensive demo capabilities for testing and presentation"

**Visual:** Contact information and next steps

**Narrator:**
"This implementation is ready for integration and can serve as a reference for other builders looking to leverage Sera's multi-currency settlement infrastructure. The code is fully functional, TypeScript-validated, and includes both mock mode for demos and production-ready API integration."

## Recording Tips

### Setup
1. Use a clean terminal window for the demo script
2. Use a code editor with good syntax highlighting for code walkthroughs
3. Ensure consistent lighting and clear audio
4. Use a screen resolution of at least 1920x1080

### During Recording
- Speak clearly and at a moderate pace
- Use mouse movements to guide attention
- Pause briefly after each major section
- Keep the demo focused on key features
- Avoid unnecessary clicks or movements

### Post-Processing
- Add captions for technical terms
- Include timestamps in video description
- Add a call-to-action for Sera ecosystem builders
- Include links to the GitHub repository

## Key Features to Emphasize

1. **Automatic Currency Detection** - No manual currency selection needed
2. **Real-time FX Rates** - Live data from Sera's multi-source pricing
3. **40+ Currency Support** - Global coverage for international commerce
4. **Transparent Pricing** - Customers see exact rates and fees
5. **Seamless Integration** - Works with existing Sera infrastructure
6. **Production Ready** - Fully tested and validated code
7. **Demo Capabilities** - Mock mode for easy demonstration

## Troubleshooting During Demo

**If demo script fails:**
- Ensure Node.js and dependencies are installed
- Check that `npx tsx` is available
- Verify the demo.ts file is in the root directory

**If server fails to start:**
- Check that .env file exists with required values
- Verify no other process is using port 3000
- Check database connection if using full server mode

**If FX rates don't load:**
- Ensure SERA_MOCK_MODE is set to 'true' for demo
- Check internet connection for location detection
- Verify Sera MCP server is built

## Follow-Up Actions

After recording the demo:
1. Upload video to YouTube or preferred platform
2. Share with Douglas and the Sera team
3. Create a GitHub issue documenting the integration
4. Write a blog post about the implementation
5. Engage with the Sera community for feedback

## Contact Information

For questions about this integration:
- GitHub: [Your GitHub]
- Twitter: [Your Twitter]
- Email: [Your Email]

Sera Ecosystem:
- Website: https://sera.cx
- Agents Platform: https://agents.sera.cx
- GitHub: https://github.com/sera-cx
