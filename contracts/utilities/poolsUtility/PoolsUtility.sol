// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "./Position.sol";

/// @title PoolsUtility
/// @notice A factory contract to create Position contract
contract PoolsUtility {
    // storage vars
    struct CoreAddrresses {
        address oracle;
        address rubiconMarket;
        address bathHouseV2;
    }
    CoreAddrresses public coreAddresses;

    bool public initialized;

    // owner of position => address of Position contract
    mapping(address => address[]) private positionAddresses;

    event PositionCreated(address position);

    //============================= PROXY-INIT =============================

    function initialize(
        address _oracle,
        address _rubiconMarket,
        address _bathHouseV2
    ) external {
        require(!initialized, "Contract already initalized!");
        coreAddresses = CoreAddrresses({
            oracle: _oracle,
            rubiconMarket: _rubiconMarket,
            bathHouseV2: _bathHouseV2
        });

        initialized = true;
    }

    //============================= VIEW =============================

    /// @return positions - an array of all positions of an `owner`
    function getPositions(
        address owner
    ) external view returns (address[] memory positions) {
        positions = positionAddresses[owner];
    }

    //============================= MAIN =============================

    /// @notice create Position contract
    function createPosition() external {
        require(initialized, "createPosition: !initialized");
        address oracle = coreAddresses.oracle;
        address rubiconMarket = coreAddresses.rubiconMarket;
        address bathHouseV2 = coreAddresses.bathHouseV2;

        Position position = new Position(oracle, rubiconMarket, bathHouseV2);
        positionAddresses[msg.sender].push(address(position));
        // make msg.sender owner of a contract
        position.transferOwnership(msg.sender);

        emit PositionCreated(address(position));
    }
}
