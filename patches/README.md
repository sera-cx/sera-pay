# Dependency patch notices

## Privy React SDK

`@privy-io__react-auth@3.37.4.patch` modifies the public
[`@privy-io/react-auth` 3.37.4 package](https://www.npmjs.com/package/@privy-io/react-auth/v/3.37.4).
The upstream package is licensed under Apache-2.0. Its unmodified license text
is included in [licenses/privy-react-auth-LICENSE.txt](licenses/privy-react-auth-LICENSE.txt).

SeraPay modification: the ESM and CommonJS mobile EVM wallet-click handlers try
WalletConnect before the SDK's dApp-browser deep link. The patch records both
the original code and the modified code. The upstream SDK code retains its
Apache-2.0 license.

## Wouter

`wouter@3.7.1.patch` modifies the public Wouter 3.7.1 package, whose upstream
package metadata declares the Unlicense. The existing patch collects route
paths for browser tooling.
