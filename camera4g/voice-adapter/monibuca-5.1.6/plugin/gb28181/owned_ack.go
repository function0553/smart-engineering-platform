package plugin_gb28181pro

// A received ACK must match the live invitation before the one known firmware
// exception is considered. No synthetic ACK or readiness override is used.
type ownedDialogIdentity struct {
	Device, RemoteUser, LocalUser, CallID, Peer, ClientTag, ServerTag string
	Sequence                                                          uint32
}

func acceptOwnedACK(want, got ownedDialogIdentity) (bool, bool) {
	if want.CallID == "" || want.Peer == "" || want.ServerTag == "" || want.ClientTag == "" ||
		got.CallID != want.CallID || got.Peer != want.Peer || got.Sequence != want.Sequence ||
		got.RemoteUser != want.RemoteUser || got.LocalUser != want.LocalUser || got.ClientTag == "" {
		return false, false
	}
	if got.ClientTag == want.ClientTag && got.ServerTag == want.ServerTag {
		return true, false
	}
	if want.Device == "34020000001320000012" && got.ServerTag == "" {
		return true, true
	}
	return false, false
}
