import unittest
from face_liveness import decision

class LivenessDecisionTests(unittest.TestCase):
    def test_live_needs_both_scales_and_sufficient_face_resolution(self):
        self.assertEqual(decision([.99,.98],110),'passed')
        self.assertEqual(decision([1.,.79],110),'rejected')
        self.assertEqual(decision([.0002,.0001],210),'rejected')
        self.assertEqual(decision([.99,.99],79),'unknown')

    def test_missing_nonfinite_and_out_of_range_scores_never_pass(self):
        for values in [[],[1.],[1.,float('nan')],[1.,float('inf')],[1.1,1.]]:
            self.assertEqual(decision(values,100),'unknown')

if __name__=='__main__':unittest.main()
