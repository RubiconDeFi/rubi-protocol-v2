// SPDX-License-Identifier: MIT

pragma solidity >=0.8.17;

import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

// ** TODO: override _setAdmin functionality to allow for abdication optionality?
abstract contract RubiconProxy is TransparentUpgradeableProxy {}
