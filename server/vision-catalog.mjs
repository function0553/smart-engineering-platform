export const FACE_MODEL_ID = 'opencv-sface-2021dec-0ba9fbfa01b5270c-yunet-2023mar-8f2383e4dd3cfbb4';
export const visionCapabilities = {
  face_capture: ['YuNet + SFace', '检测、对齐、特征比对；不包含活体检测，需使用本模型重新提取名单特征。'],
  people_count: ['YOLOX + 目标跟踪', '单摄像头短时轨迹去重，不是跨镜身份去重；遮挡和重连可能产生新轨迹。'],
  presence: ['YOLOX + 区域计时', '检测区域无人持续时长；不能单凭画面确认某位员工是否在岗。'],
  crowd: ['YOLOX + 区域计数', '按区域内可见人数阈值判断聚集。'],
  intrusion: ['YOLOX + 几何规则', '人员脚点与多边形或越界线判断。'],
  loitering: ['YOLOX + 轨迹计时', '对区域内连续可见轨迹计时；丢失目标后重新计时。'],
  trajectory: ['YOLOX + 目标跟踪', '单路视频匿名轨迹，不代表访客身份或跨摄像头追踪。'],
  traffic: ['YOLOX + 轨迹计数', '当前人数、短时轨迹数量和画面热区。'],
  smoking: ['PP-YOLOE 香烟专项 + 人员检测', '输出疑似抽烟：在人员近景中检测香烟小目标，不能确认完整动作、不检测烟雾；遮挡、远景、电子烟可能漏检，需复核。'],
  fire_lane: ['YOLOX + 占用计时', '对用户划定通道中的人、车辆和行李等可识别目标计时，需现场确认区域。'],
  occlusion: ['图像统计诊断', '低对比度画面异常候选；需现场标定，不保证覆盖所有遮挡。'],
  blur: ['图像锐度诊断', '拉普拉斯锐度阈值，需按分辨率和现场画面标定。'],
  night: ['图像亮度诊断', '持续低照度候选，不能据此确认夜视硬件故障。'],
};
export const localFenceEvents = ['intrusion', 'line_crossing'];
