"""Daily clock-in policy, evaluated against server frame receipt time."""
from datetime import datetime, time, timedelta, timezone
import math
import re

SHANGHAI = timezone(timedelta(hours=8))


class AttendancePolicy:
    def __init__(self, config=None):
        config = config or {}
        if set(config) - {'timezone', 'start', 'normal_until'}:
            raise ValueError('unknown_attendance_policy_setting')
        if config.get('timezone', 'Asia/Shanghai') != 'Asia/Shanghai':
            raise ValueError('attendance_timezone_must_be_shanghai')
        def parse(value):
            if not isinstance(value, str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', value):
                raise ValueError('attendance_time_requires_HH_MM')
            return time.fromisoformat(value)
        self.start = parse(config.get('start', '08:00'))
        self.normal_until = parse(config.get('normal_until', '09:05'))
        if self.start > self.normal_until:
            raise ValueError('attendance_start_after_deadline')

    def info(self):
        return {'timezone': 'Asia/Shanghai', 'start': self.start.strftime('%H:%M'),
                'normal_until': self.normal_until.strftime('%H:%M'),
                'normal_until_inclusive': True, 'before_start': 'not_recorded',
                'after_normal_until': 'late', 'frequency': 'first_clock_in_per_day'}

    def classify(self, when):
        if isinstance(when, str):
            when = datetime.fromisoformat(when.replace('Z', '+00:00'))
        if when.tzinfo is None:
            raise ValueError('observation_provenance_required')
        local = when.astimezone(SHANGHAI)
        start = datetime.combine(local.date(), self.start, SHANGHAI)
        deadline = datetime.combine(local.date(), self.normal_until, SHANGHAI)
        allowed = local >= start
        return {'allowed': allowed, 'business_date': local.date().isoformat(),
                'attendance_status': 'too_early' if not allowed else 'late' if local > deadline else 'on_time',
                'late_seconds': max(0, math.ceil((local-deadline).total_seconds())) if allowed else 0}
