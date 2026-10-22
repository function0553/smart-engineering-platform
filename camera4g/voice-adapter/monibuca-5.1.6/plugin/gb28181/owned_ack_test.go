package plugin_gb28181pro

import "testing"

func TestOwnedACKAssociation(t *testing.T) {
	expected := ownedDialogIdentity{Device: "34020000001320000012", RemoteUser: "34020000001320000012", LocalUser: "34020000002000000001", CallID: "random-call", Peer: "58.220.220.65:16310", Sequence: 5643, ClientTag: "original", ServerTag: "server-random"}
	observed := expected
	observed.ClientTag, observed.ServerTag = "camera-regenerated", ""
	cases := []struct {
		name    string
		mutate  func(*ownedDialogIdentity)
		allowed bool
		compat  bool
	}{
		{"actual firmware ACK", func(*ownedDialogIdentity) {}, true, true},
		{"wrong peer", func(x *ownedDialogIdentity) { x.Peer = "58.220.220.65:16311" }, false, false},
		{"wrong call", func(x *ownedDialogIdentity) { x.CallID = "another-call" }, false, false},
		{"wrong sequence", func(x *ownedDialogIdentity) { x.Sequence++ }, false, false},
		{"wrong sender", func(x *ownedDialogIdentity) { x.RemoteUser = "another-device" }, false, false},
		{"wrong recipient", func(x *ownedDialogIdentity) { x.LocalUser = "another-platform" }, false, false},
		{"present wrong To tag", func(x *ownedDialogIdentity) { x.ServerTag = "wrong-tag" }, false, false},
		{"empty From tag", func(x *ownedDialogIdentity) { x.ClientTag = "" }, false, false},
		{"normal ACK", func(x *ownedDialogIdentity) { x.ClientTag = expected.ClientTag; x.ServerTag = expected.ServerTag }, true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			x := observed
			c.mutate(&x)
			ok, compat := acceptOwnedACK(expected, x)
			if ok != c.allowed || compat != c.compat {
				t.Fatalf("got %v,%v want %v,%v", ok, compat, c.allowed, c.compat)
			}
		})
	}
	expected.Device = "34020000001110000011"
	if ok, _ := acceptOwnedACK(expected, observed); ok {
		t.Fatal("firmware exception leaked to another device")
	}
}
