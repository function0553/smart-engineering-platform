// Values transcribed from the user-supplied 2026-10-07 reference, never seeded into business storage.
export function referenceReport() {
  const section = (name, designQuantity, cumulativeProgress) => ({ name, kind: 'pipeline', designQuantity, todayProgress: '0', cumulativeProgress, works: [], todayNotes: '节假日不能施工', machinery: '无', workers: '0', security: '无', tomorrow: '节假日不能施工。', procedures: '无', difficulties: '无' });
  const first = section('经开区中曹南郊互联互通', '4287', '34.5');
  Object.assign(first, { todayProgress: '1', todayNotes: '', machinery: '发电机1台，挖掘机2台、自卸汽车2台、风镐1台', workers: '15', security: '8', tomorrow: '沟槽开挖、管道安装。', works: ['路面破碎', '沟槽开挖', '切缝', '土石方外运', '砂垫层', '回填砂', 'DN500管安装', '路面混凝土恢复'].map(name => ({ name, quantity: name === '切缝' ? '72' : '36', unit: 'm' })) });
  return { projectName: '贵阳市供水管网改造工程三期施工Ⅰ标段', region: '经开区', reportDate: '2026-10-07', number: '', weather: '晴', sections: [first, section('经开区乐街小区', '4837.8', '69.5'), section('经开区香江花园', '3740', '30'), { ...section('水表更换', '112566', '10267'), kind: 'meter', todayNotes: '', machinery: '', tomorrow: '水表更换。', procedures: '', difficulties: '', works: [{ name: '水表更换', quantity: '0', unit: '块' }] }], nextPlan: '管沟沟槽开挖。\n余方弃置。\n管道安装。', otherItems: '无', photos: [] };
}
