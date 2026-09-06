// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title BULWARK Blocklist — the shared memory of attackers.
/// @notice Destination addresses flagged by verified verdicts. Read by every
///          Watcher fleet-wide; strikes compound (3 strikes → hard flag).
///          Fed by prior BULWARK claims — "every attack enriches the blocklist".

import {IBlocklist} from "./interfaces/IBlocklist.sol";

contract Blocklist is IBlocklist {
    // ----------------------------------------------------------------- //
    //                              Events                               //
    // ----------------------------------------------------------------- //

    event Reported(address indexed destination, uint8 strikes, bytes32 indexed evidence);
    event Cleared(address indexed destination);
    event AdminChanged(address indexed previousAdmin, address indexed newAdmin);
    event ReporterSet(address indexed reporter, bool allowed);

    // ----------------------------------------------------------------- //
    //                              Errors                               //
    // ----------------------------------------------------------------- //

    error NotReporter();
    error ZeroAddress();
    error AlreadyCleared();

    // ----------------------------------------------------------------- //
    //                            Storage                                //
    // ----------------------------------------------------------------- //

    /// @dev destination => number of confirmed strikes.
    mapping(address destination => uint8 strikes) public strikes;

    /// @dev destination => true if a governance/arb path cleared it.
    mapping(address destination => bool) private _cleared;

    /// @dev Reporters are the VerdictContract (and dao-set curators).
    mapping(address reporter => bool) public isReporter;

    address public admin;

    // ----------------------------------------------------------------- //
    //                          Lifecycle                                //
    // ----------------------------------------------------------------- //

    constructor() {
        admin = msg.sender;
        isReporter[msg.sender] = true;
    }

    function setAdmin(address newAdmin) external {
        if (msg.sender != admin) revert NotReporter();
        if (newAdmin == address(0)) revert ZeroAddress();
        address previous = admin;
        admin = newAdmin;
        emit AdminChanged(previous, newAdmin);
    }

    /// @notice Grant or revoke the report privilege (VerdictContract gets it at wiring).
    function setReporter(address reporter, bool allowed) external {
        if (msg.sender != admin) revert NotReporter();
        if (reporter == address(0)) revert ZeroAddress();
        isReporter[reporter] = allowed;
        emit ReporterSet(reporter, allowed);
    }

    // ----------------------------------------------------------------- //
    //                            Reporting                              //
    // ----------------------------------------------------------------- //

    /// @notice Record a strike against a destination, gated on verdict authority.
    /// @param destination the attacker / drainer address
    /// @param evidence    hash of the forensics package (verdict id, trace, etc.)
    function report(address destination, bytes32 evidence) external {
        if (!isReporter[msg.sender]) revert NotReporter();
        if (destination == address(0)) revert ZeroAddress();
        delete _cleared[destination];
        strikes[destination] += 1;
        emit Reported(destination, strikes[destination], evidence);
    }

    /// @notice Arbitration outcome: clear a false positive (Case 7 pattern).
    function clear(address destination) external {
        if (msg.sender != admin && !isReporter[msg.sender]) revert NotReporter();
        if (strikes[destination] == 0) revert AlreadyCleared();
        delete strikes[destination];
        delete _cleared[destination];
        emit Cleared(destination);
    }

    // ----------------------------------------------------------------- //
    //                             Reads                                 //
    // ----------------------------------------------------------------- //

    /// @dev 3+ strikes = hard flag ("second/third strike" in the plan's cases).
    function isFlagged(address destination) external view returns (bool) {
        return strikes[destination] >= 3 && !_cleared[destination];
    }

    /// @dev Single strike still matters: it elevates the tier in the Watcher.
    function hasAnyStrike(address destination) external view returns (bool) {
        return strikes[destination] > 0 && !_cleared[destination];
    }

    function isCleared(address destination) external view returns (bool) {
        return _cleared[destination];
    }
}
