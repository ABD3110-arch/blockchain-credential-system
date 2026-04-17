// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

contract AcademicCredentials {

    address public admin;

    constructor() {
        admin = msg.sender;
    }

    struct Credential {
        string studentName;
        string course;
        string ipfsHash;
        address issuedBy;
    }

    mapping(string => Credential) public credentials;

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not authorized");
        _;
    }

    function addCredential(
        string memory _id,
        string memory _name,
        string memory _course,
        string memory _ipfsHash
    ) public onlyAdmin {

        require(bytes(credentials[_id].studentName).length == 0, "Already exists");

        credentials[_id] = Credential(
            _name,
            _course,
            _ipfsHash,
            msg.sender
        );
    }

    function verifyCredential(string memory _id)
        public
        view
        returns (string memory, string memory, string memory, address)
    {
        Credential memory c = credentials[_id];
        return (c.studentName, c.course, c.ipfsHash, c.issuedBy);
    }

    function updateCredential(
        string memory _id,
        string memory _newHash
    ) public onlyAdmin {
        credentials[_id].ipfsHash = _newHash;
    }
}