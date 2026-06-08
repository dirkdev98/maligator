#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "bound_function_object.h"
#include "function_object.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "object.h"
#include "object_ops.h"
#include "property_iter.h"
#include "property_store.h"
#include "table.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// === GENERATED from tests/local/tmp2.js via `node src/index.ts tests/local/tmp2.js` ===
static const c16 mal_string_0_code_units[] = { 0 };
static const c16 mal_string_1_code_units[] = { 100, 101, 102, 105, 110, 101, 80, 114, 111, 112, 101, 114, 116, 121 };
static const c16 mal_string_2_code_units[] = { 120 };
static const c16 mal_string_3_code_units[] = { 118, 97, 108, 117, 101 };
static const c16 mal_string_4_code_units[] = { 119, 114, 105, 116, 97, 98, 108, 101 };
static const c16 mal_string_5_code_units[] = { 101, 110, 117, 109, 101, 114, 97, 98, 108, 101 };
static const c16 mal_string_6_code_units[] = { 109, 97, 112 };
static const c16 mal_string_7_code_units[] = { 107, 101, 121, 115 };
static const c16 mal_string_8_code_units[] = { 114, 101, 100, 117, 99, 101 };
static const c16 mal_string_9_code_units[] = { 97, 116, 116, 101, 109, 112, 116 };
static const c16 mal_string_10_code_units[] = { 98, 111, 111, 109 };
static const c16 mal_string_11_code_units[] = { 109, 101, 115, 115, 97, 103, 101 };
static const c16 mal_string_12_code_units[] = { 110, 97, 109, 101 };
static const c16 mal_string_13_code_units[] = { 87, 114, 97, 112, 112, 101, 114 };
static const c16 mal_string_14_code_units[] = { 112, 114, 111, 116, 111, 116, 121, 112, 101 };
static const c16 mal_string_15_code_units[] = { 107, 105, 110, 100 };
static const c16 mal_string_16_code_units[] = { 111, 111, 112, 115 };
static const c16 mal_string_17_code_units[] = { 111, 117, 116, 32, 111, 102, 32, 114, 97, 110, 103, 101 };
static const c16 mal_string_18_code_units[] = { 112, 97, 105, 114, 83, 117, 109 };
static const c16 mal_string_19_code_units[] = { 99, 97, 108, 108 };
static const c16 mal_string_20_code_units[] = { 97, 112, 112, 108, 121 };
static const c16 mal_string_21_code_units[] = { 98, 105, 110, 100 };
static const c16 mal_string_22_code_units[] = { 108, 101, 110, 103, 116, 104 };
static const c16 mal_string_23_code_units[] = { 84, 121, 112, 101, 69, 114, 114, 111, 114 };
static const c16 mal_string_24_code_units[] = { 69, 114, 114, 111, 114 };
static const c16 mal_string_25_code_units[] = { 82, 97, 110, 103, 101, 69, 114, 114, 111, 114 };
static const c16 mal_string_26_code_units[] = { 32, 32, 72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 32, 32 };
static const c16 mal_string_27_code_units[] = { 116, 114, 105, 109 };
static const c16 mal_string_28_code_units[] = { 116, 111, 85, 112, 112, 101, 114, 67, 97, 115, 101 };
static const c16 mal_string_29_code_units[] = { 97, 44, 98, 44, 99 };
static const c16 mal_string_30_code_units[] = { 115, 112, 108, 105, 116 };
static const c16 mal_string_31_code_units[] = { 44 };
static const c16 mal_string_32_code_units[] = { 52, 50 };
static const c16 mal_string_33_code_units[] = { 105, 115, 73, 110, 116, 101, 103, 101, 114 };
static const c16 mal_string_34_code_units[] = { 115, 116, 114, 105, 110, 103 };
static const c16 mal_string_35_code_units[] = { 102, 97, 108, 108, 98, 97, 99, 107 };
static const c16 mal_string_36_code_units[] = { 112, 114, 101, 115, 101, 110, 116 };
static const c16 mal_string_37_code_units[] = { 103, 111, 110, 101 };
static const c16 mal_string_38_code_units[] = { 109, 105, 115, 115, 105, 110, 103 };
static const c16 mal_string_39_code_units[] = { 116, 111, 83, 116, 114, 105, 110, 103 };
static const c16 mal_string_40_code_units[] = { 117, 110, 100, 101, 102, 105, 110, 101, 100 };
static const c16 mal_string_41_code_units[] = { 111, 98, 106, 101, 99, 116 };
static const c16 mal_string_42_code_units[] = { 98, 111, 111, 108, 101, 97, 110 };
static const c16 mal_string_43_code_units[] = { 110, 117, 109, 98, 101, 114 };
static const c16 mal_string_44_code_units[] = { 102, 117, 110, 99, 116, 105, 111, 110 };
static const c16 mal_string_45_code_units[] = { 95, 118 };
static const c16 mal_string_46_code_units[] = { 118 };
static const c16 mal_string_47_code_units[] = { 103, 101, 116, 32, 118 };
static const c16 mal_string_48_code_units[] = { 115, 101, 116, 32, 118 };
static const c16 mal_string_49_code_units[] = { 116, 119, 105, 99, 101 };
static const c16 mal_string_50_code_units[] = { 99, 111, 109, 112, 117, 116, 101, 100 };
static const c16 mal_string_51_code_units[] = { 103, 101, 116 };
static const c16 mal_string_52_code_units[] = { 99, 111, 110, 102, 105, 103, 117, 114, 97, 98, 108, 101 };
static const c16 mal_string_53_code_units[] = { 112, 114, 111, 112 };
static const c16 mal_string_54_code_units[] = { 114, 111 };
static const c16 mal_string_55_code_units[] = { 72, 111, 108, 100, 101, 114 };
static const c16 mal_string_56_code_units[] = { 116, 97, 103 };
static const c16 mal_string_57_code_units[] = { 103, 101, 116, 32, 116, 97, 103 };
static const c16 mal_string_58_code_units[] = { 110, 101, 118, 101, 114, 68, 101, 99, 108, 97, 114, 101, 100, 65, 110, 121, 119, 104, 101, 114, 101 };
static const c16 mal_string_59_code_units[] = { 82, 101, 102, 101, 114, 101, 110, 99, 101, 69, 114, 114, 111, 114 };
static const c16 mal_string_60_code_units[] = { 110, 101, 118, 101, 114, 68, 101, 99, 108, 97, 114, 101, 100, 65, 110, 121, 119, 104, 101, 114, 101, 32, 105, 115, 32, 110, 111, 116, 32, 100, 101, 102, 105, 110, 101, 100 };
static const c16 mal_string_61_code_units[] = { 115, 116, 114, 105, 110, 103, 105, 102, 121 };
static const c16 mal_string_62_code_units[] = { 106 };
static const c16 mal_string_63_code_units[] = { 103, 101, 116, 32, 106 };
static const c16 mal_string_64_code_units[] = { 99, 111, 117, 110, 116, 101, 114 };
static const c16 mal_string_65_code_units[] = { 97, 100, 100, 101, 114 };
static const c16 mal_string_66_code_units[] = { 109, 97, 107, 101, 67, 101, 108, 108 };
static const c16 mal_string_67_code_units[] = { 103, 101, 116, 32, 118, 97, 108, 117, 101 };
static const c16 mal_string_68_code_units[] = { 115, 101, 116, 32, 118, 97, 108, 117, 101 };
static const c16 mal_string_69_code_units[] = { 83, 104, 97, 112, 101 };
static const c16 mal_string_70_code_units[] = { 100, 101, 115, 99, 114, 105, 98, 101 };
static const c16 mal_string_71_code_units[] = { 58 };
static const c16 mal_string_72_code_units[] = { 115, 105, 100, 101, 115 };
static const c16 mal_string_73_code_units[] = { 102, 97, 109, 105, 108, 121 };
static const c16 mal_string_74_code_units[] = { 115, 104, 97, 112, 101 };
static const c16 mal_string_75_code_units[] = { 83, 113, 117, 97, 114, 101 };
static const c16 mal_string_76_code_units[] = { 115, 113, 117, 97, 114, 101 };
static const c16 mal_string_77_code_units[] = { 115, 105, 122, 101 };
static const c16 mal_string_78_code_units[] = { 99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114 };
static const c16 mal_string_79_code_units[] = { 97, 114, 101, 97 };
static const c16 mal_string_80_code_units[] = { 64 };
static const c16 mal_string_81_code_units[] = { 115, 113, 117, 97, 114, 101, 58, 52, 64, 51 };
static const c16 mal_string_82_code_units[] = { 115 };
static const c16 mal_string_83_code_units[] = { 109, 97, 120 };
static const c16 mal_string_84_code_units[] = { 109, 105, 110 };
static const c16 mal_string_85_code_units[] = { 97, 98, 115 };
static const c16 mal_string_86_code_units[] = { 102, 108, 111, 111, 114 };
static const c16 mal_string_87_code_units[] = { 114, 111, 117, 110, 100 };
static const c16 mal_string_88_code_units[] = { 116, 114, 117, 110, 99 };
static const c16 mal_string_89_code_units[] = { 112, 111, 119 };
static const c16 mal_string_90_code_units[] = { 97 };
static const c16 mal_string_91_code_units[] = { 98 };
static const c16 mal_string_92_code_units[] = { 112, 97, 114, 115, 101 };
static const c16 mal_string_93_code_units[] = { 77, 97, 116, 104 };
static const c16 mal_string_94_code_units[] = { 108, 111, 103 };
static const c16 mal_string_95_code_units[] = { 109, 97, 108, 105, 103, 97, 116, 111, 114, 32, 102, 105, 120, 116, 117, 114, 101, 32, 114, 101, 115, 117, 108, 116, 32, 105, 110, 99, 111, 109, 105, 110, 103, 58 };
static const c16 mal_string_96_code_units[] = { 99 };
static const c16 mal_string_97_code_units[] = { 100 };
static const c16 mal_string_98_code_units[] = { 110, 101, 115, 116, 101, 100 };
static const c16 mal_string_99_code_units[] = { 100, 101, 101, 112 };
static const c16 mal_string_100_code_units[] = { 100, 112, 97, 114, 97, 109, 115 };
static const c16 mal_string_101_code_units[] = { 121 };
static const c16 mal_string_102_code_units[] = { 100, 114, 101, 115, 116, 79, 110, 108, 121 };
static const c16 mal_string_103_code_units[] = { 100, 99, 104, 97, 105, 110 };
static const c16 mal_string_104_code_units[] = { 100, 108, 97, 122, 121, 68, 101, 102, 97, 117, 108, 116 };
static const c16 mal_string_105_code_units[] = { 102 };
static const c16 mal_string_106_code_units[] = { 100, 97, 114, 103, 67, 111, 117, 110, 116 };
static const c16 mal_string_107_code_units[] = { 100, 65, 114, 114, 111, 119 };
static const c16 mal_string_108_code_units[] = { 100, 108, 101, 110, 66 };
static const c16 mal_string_109_code_units[] = { 100, 108, 101, 110, 67 };
static const c16 mal_string_110_code_units[] = { 100, 108, 101, 110, 68 };
static const c16 mal_string_111_code_units[] = { 100, 97, 120 };
static const c16 mal_string_112_code_units[] = { 108, 101, 102, 116 };
static const c16 mal_string_113_code_units[] = { 114, 105, 103, 104, 116 };
static const c16 mal_string_114_code_units[] = { 97, 98, 99, 100 };
static const c16 mal_string_115_code_units[] = { 120, 121 };
static const c16 mal_string_116_code_units[] = { 100, 98, 111, 111, 109 };
static const c16 mal_string_117_code_units[] = { 84, 121, 112, 101, 69, 114, 114, 111, 114, 58, 100, 98, 111, 111, 109 };
static const c16 mal_string_118_code_units[] = { 110, 97, 109, 101, 100, 65, 114, 114, 111, 119 };
static const c16 mal_string_119_code_units[] = { 110, 97, 109, 101, 100, 70, 110, 69, 120, 112, 114 };
static const c16 mal_string_120_code_units[] = { 110, 97, 109, 101, 100, 67, 108, 97, 115, 115 };
static const c16 mal_string_121_code_units[] = { 100, 102, 108, 116 };
static const c16 mal_string_122_code_units[] = { 115, 101, 116, 80, 114, 111, 116, 111, 116, 121, 112, 101, 79, 102 };
static const c16 mal_string_123_code_units[] = { 112, 114, 101, 118, 101, 110, 116, 69, 120, 116, 101, 110, 115, 105, 111, 110, 115 };
static const c16 mal_string_124_code_units[] = { 123, 32, 34, 95, 95, 112, 114, 111, 116, 111, 95, 95, 34, 58, 32, 55, 32, 125 };
static const c16 mal_string_125_code_units[] = { 115, 112, 108, 105, 99, 101 };
static const c16 mal_string_126_code_units[] = { 103, 101, 116, 80, 114, 111, 116, 111, 116, 121, 112, 101, 79, 102 };
static const c16 mal_string_127_code_units[] = { 95, 95, 112, 114, 111, 116, 111, 95, 95 };
static const c16 mal_string_128_code_units[] = { 104, 97, 115, 79, 119, 110, 80, 114, 111, 112, 101, 114, 116, 121 };
static const c16 mal_string_129_code_units[] = { 111, 110, 101 };
static const c16 mal_string_130_code_units[] = { 97, 108, 112, 104, 97 };
static const c16 mal_string_131_code_units[] = { 115, 101, 116 };
static const c16 mal_string_132_code_units[] = { 110, 97, 110 };
static const c16 mal_string_133_code_units[] = { 122, 101, 114, 111 };
static const c16 mal_string_134_code_units[] = { 116, 119, 111 };
static const c16 mal_string_135_code_units[] = { 100, 101, 108, 101, 116, 101 };
static const c16 mal_string_136_code_units[] = { 104, 97, 115 };
static const c16 mal_string_137_code_units[] = { 97, 108, 112, 104, 97, 50 };
static const c16 mal_string_138_code_units[] = { 102, 111, 114, 69, 97, 99, 104 };
static const c16 mal_string_139_code_units[] = { 112, 117, 115, 104 };
static const c16 mal_string_140_code_units[] = { 106, 111, 105, 110 };
static const c16 mal_string_141_code_units[] = { 97, 44, 78, 97, 78, 44, 48, 44, 50 };
static const c16 mal_string_142_code_units[] = { 110, 101, 120, 116 };
static const c16 mal_string_143_code_units[] = { 105, 116, 101, 114, 97, 116, 111, 114 };
static const c16 mal_string_144_code_units[] = { 97, 100, 100 };
static const c16 mal_string_145_code_units[] = { 118, 97, 108, 117, 101, 115 };
static const c16 mal_string_146_code_units[] = { 101, 110, 116, 114, 105, 101, 115 };
static const c16 mal_string_147_code_units[] = { 43 };
static const c16 mal_string_148_code_units[] = { 49, 43, 50, 48 };
static const c16 mal_string_149_code_units[] = { 107 };
static const c16 mal_string_150_code_units[] = { 99, 108, 101, 97, 114 };
static const c16 mal_string_151_code_units[] = { 100, 111, 110, 101 };
static const c16 mal_string_152_code_units[] = { 97, 98 };
static const c16 mal_string_153_code_units[] = { 55357, 56832, 120 };
static const c16 mal_string_154_code_units[] = { 110, 111, 112, 101 };
static const c16 mal_string_155_code_units[] = { 115, 121, 109, 98, 111, 108 };
static const c16 mal_string_156_code_units[] = { 100, 101, 115, 99, 114, 105, 112, 116, 105, 111, 110 };
static const c16 mal_string_157_code_units[] = { 83, 121, 109, 98, 111, 108, 40, 83, 121, 109, 98, 111, 108, 46, 105, 116, 101, 114, 97, 116, 111, 114, 41 };
static const c16 mal_string_158_code_units[] = { 91, 111, 98, 106, 101, 99, 116, 32, 77, 97, 112, 93 };
static const c16 mal_string_159_code_units[] = { 91, 111, 98, 106, 101, 99, 116, 32, 83, 101, 116, 93 };
static const c16 mal_string_160_code_units[] = { 91, 111, 98, 106, 101, 99, 116, 32, 83, 121, 109, 98, 111, 108, 93 };
static const c16 mal_string_161_code_units[] = { 91, 111, 98, 106, 101, 99, 116, 32, 77, 97, 116, 104, 93 };
static const c16 mal_string_162_code_units[] = { 116, 111, 83, 116, 114, 105, 110, 103, 84, 97, 103 };
static const c16 mal_string_163_code_units[] = { 67, 117, 115, 116, 111, 109 };
static const c16 mal_string_164_code_units[] = { 91, 111, 98, 106, 101, 99, 116, 32, 67, 117, 115, 116, 111, 109, 93 };
static const c16 mal_string_165_code_units[] = { 104, 97, 115, 73, 110, 115, 116, 97, 110, 99, 101 };
static const c16 mal_string_166_code_units[] = { 73, 110, 115, 116, 97, 110, 99, 101, 84, 97, 114, 103, 101, 116 };
static const c16 mal_string_167_code_units[] = { 115, 112, 101, 99, 105, 101, 115 };
static const c16 mal_string_168_code_units[] = { 105, 115, 67, 111, 110, 99, 97, 116, 83, 112, 114, 101, 97, 100, 97, 98, 108, 101 };
static const c16 mal_string_169_code_units[] = { 99, 111, 110, 99, 97, 116 };
static const c16 mal_string_170_code_units[] = { 120, 121, 122 };
static const c16 mal_string_171_code_units[] = { 97, 49, 98, 50 };
static const c16 mal_string_172_code_units[] = { 116, 114, 97, 99, 107, 101, 100, 73, 116, 101, 114, 97, 98, 108, 101 };
static const c16 mal_string_173_code_units[] = { 114, 101, 116, 117, 114, 110 };
static const c16 mal_string_174_code_units[] = { 115, 116, 111, 112 };
static const c16 mal_string_175_code_units[] = { 52, 48, 43, 53, 48 };
static const c16 mal_string_176_code_units[] = { 48, 49, 50, 51 };
static const c16 mal_string_177_code_units[] = { 115, 112, 114, 101, 97, 100, 83, 117, 109 };
static const c16 mal_string_178_code_units[] = { 83, 112, 114, 101, 97, 100, 67, 116, 111, 114 };
static const c16 mal_string_179_code_units[] = { 116, 111, 116, 97, 108 };
static const c16 mal_string_180_code_units[] = { 102, 111, 114 };
static const c16 mal_string_181_code_units[] = { 116, 46, 107, 101, 121 };
static const c16 mal_string_182_code_units[] = { 107, 101, 121, 70, 111, 114 };
static const c16 mal_string_183_code_units[] = { 108, 111, 111, 115, 101 };
static const c16 mal_string_184_code_units[] = { 114, 101, 103, 105, 115, 116, 101, 114, 101, 100 };
static const c16 mal_string_185_code_units[] = { 105, 109, 117, 108 };
static const c16 mal_string_186_code_units[] = { 99, 108, 122, 51, 50 };
static const c16 mal_string_187_code_units[] = { 102, 114, 111, 109, 67, 111, 100, 101, 80, 111, 105, 110, 116 };
static const c16 mal_string_188_code_units[] = { 99, 111, 100, 101, 80, 111, 105, 110, 116, 65, 116 };
static const c16 mal_string_189_code_units[] = { 102, 114, 111, 109 };
static const c16 mal_string_190_code_units[] = { 50, 43, 52 };
static const c16 mal_string_191_code_units[] = { 102, 114, 111, 109, 69, 110, 116, 114, 105, 101, 115 };
static const c16 mal_string_192_code_units[] = { 113 };
static const c16 mal_string_193_code_units[] = { 103, 114, 111, 117, 112, 66, 121 };
static const c16 mal_string_194_code_units[] = { 111 };
static const c16 mal_string_195_code_units[] = { 101 };
static const c16 mal_string_196_code_units[] = { 49 };
static const c16 mal_string_197_code_units[] = { 48, 49 };
static const c16 mal_string_198_code_units[] = { 99, 114, 101, 97, 116, 101 };
static const c16 mal_string_199_code_units[] = { 105, 110, 104, 101, 114, 105, 116, 101, 100 };
static const c16 mal_string_200_code_units[] = { 111, 119, 110 };
static const c16 mal_string_201_code_units[] = { 99, 111, 108, 108, 101, 99, 116, 105, 111, 110, 115, 58 };
static const c16 mal_string_202_code_units[] = { 105, 116, 101, 114, 97, 116, 105, 111, 110, 58 };
static const c16 mal_string_203_code_units[] = { 114, 101, 115, 117, 108, 116, 58 };
static const c16 mal_string_204_code_units[] = { 116, 109, 112, 50, 46, 106, 115, 32, 101, 120, 112, 101, 99, 116, 101, 100, 32, 114, 101, 115, 117, 108, 116, 32, 49, 55, 56, 54, 32, 98, 117, 116, 32, 103, 111, 116, 32 };

static const MalStringConstant mal_string_constants[] = {
    { .length = 0, .code_units = mal_string_0_code_units },
    { .length = 14, .code_units = mal_string_1_code_units },
    { .length = 1, .code_units = mal_string_2_code_units },
    { .length = 5, .code_units = mal_string_3_code_units },
    { .length = 8, .code_units = mal_string_4_code_units },
    { .length = 10, .code_units = mal_string_5_code_units },
    { .length = 3, .code_units = mal_string_6_code_units },
    { .length = 4, .code_units = mal_string_7_code_units },
    { .length = 6, .code_units = mal_string_8_code_units },
    { .length = 7, .code_units = mal_string_9_code_units },
    { .length = 4, .code_units = mal_string_10_code_units },
    { .length = 7, .code_units = mal_string_11_code_units },
    { .length = 4, .code_units = mal_string_12_code_units },
    { .length = 7, .code_units = mal_string_13_code_units },
    { .length = 9, .code_units = mal_string_14_code_units },
    { .length = 4, .code_units = mal_string_15_code_units },
    { .length = 4, .code_units = mal_string_16_code_units },
    { .length = 12, .code_units = mal_string_17_code_units },
    { .length = 7, .code_units = mal_string_18_code_units },
    { .length = 4, .code_units = mal_string_19_code_units },
    { .length = 5, .code_units = mal_string_20_code_units },
    { .length = 4, .code_units = mal_string_21_code_units },
    { .length = 6, .code_units = mal_string_22_code_units },
    { .length = 9, .code_units = mal_string_23_code_units },
    { .length = 5, .code_units = mal_string_24_code_units },
    { .length = 10, .code_units = mal_string_25_code_units },
    { .length = 15, .code_units = mal_string_26_code_units },
    { .length = 4, .code_units = mal_string_27_code_units },
    { .length = 11, .code_units = mal_string_28_code_units },
    { .length = 5, .code_units = mal_string_29_code_units },
    { .length = 5, .code_units = mal_string_30_code_units },
    { .length = 1, .code_units = mal_string_31_code_units },
    { .length = 2, .code_units = mal_string_32_code_units },
    { .length = 9, .code_units = mal_string_33_code_units },
    { .length = 6, .code_units = mal_string_34_code_units },
    { .length = 8, .code_units = mal_string_35_code_units },
    { .length = 7, .code_units = mal_string_36_code_units },
    { .length = 4, .code_units = mal_string_37_code_units },
    { .length = 7, .code_units = mal_string_38_code_units },
    { .length = 8, .code_units = mal_string_39_code_units },
    { .length = 9, .code_units = mal_string_40_code_units },
    { .length = 6, .code_units = mal_string_41_code_units },
    { .length = 7, .code_units = mal_string_42_code_units },
    { .length = 6, .code_units = mal_string_43_code_units },
    { .length = 8, .code_units = mal_string_44_code_units },
    { .length = 2, .code_units = mal_string_45_code_units },
    { .length = 1, .code_units = mal_string_46_code_units },
    { .length = 5, .code_units = mal_string_47_code_units },
    { .length = 5, .code_units = mal_string_48_code_units },
    { .length = 5, .code_units = mal_string_49_code_units },
    { .length = 8, .code_units = mal_string_50_code_units },
    { .length = 3, .code_units = mal_string_51_code_units },
    { .length = 12, .code_units = mal_string_52_code_units },
    { .length = 4, .code_units = mal_string_53_code_units },
    { .length = 2, .code_units = mal_string_54_code_units },
    { .length = 6, .code_units = mal_string_55_code_units },
    { .length = 3, .code_units = mal_string_56_code_units },
    { .length = 7, .code_units = mal_string_57_code_units },
    { .length = 21, .code_units = mal_string_58_code_units },
    { .length = 14, .code_units = mal_string_59_code_units },
    { .length = 36, .code_units = mal_string_60_code_units },
    { .length = 9, .code_units = mal_string_61_code_units },
    { .length = 1, .code_units = mal_string_62_code_units },
    { .length = 5, .code_units = mal_string_63_code_units },
    { .length = 7, .code_units = mal_string_64_code_units },
    { .length = 5, .code_units = mal_string_65_code_units },
    { .length = 8, .code_units = mal_string_66_code_units },
    { .length = 9, .code_units = mal_string_67_code_units },
    { .length = 9, .code_units = mal_string_68_code_units },
    { .length = 5, .code_units = mal_string_69_code_units },
    { .length = 8, .code_units = mal_string_70_code_units },
    { .length = 1, .code_units = mal_string_71_code_units },
    { .length = 5, .code_units = mal_string_72_code_units },
    { .length = 6, .code_units = mal_string_73_code_units },
    { .length = 5, .code_units = mal_string_74_code_units },
    { .length = 6, .code_units = mal_string_75_code_units },
    { .length = 6, .code_units = mal_string_76_code_units },
    { .length = 4, .code_units = mal_string_77_code_units },
    { .length = 11, .code_units = mal_string_78_code_units },
    { .length = 4, .code_units = mal_string_79_code_units },
    { .length = 1, .code_units = mal_string_80_code_units },
    { .length = 10, .code_units = mal_string_81_code_units },
    { .length = 1, .code_units = mal_string_82_code_units },
    { .length = 3, .code_units = mal_string_83_code_units },
    { .length = 3, .code_units = mal_string_84_code_units },
    { .length = 3, .code_units = mal_string_85_code_units },
    { .length = 5, .code_units = mal_string_86_code_units },
    { .length = 5, .code_units = mal_string_87_code_units },
    { .length = 5, .code_units = mal_string_88_code_units },
    { .length = 3, .code_units = mal_string_89_code_units },
    { .length = 1, .code_units = mal_string_90_code_units },
    { .length = 1, .code_units = mal_string_91_code_units },
    { .length = 5, .code_units = mal_string_92_code_units },
    { .length = 4, .code_units = mal_string_93_code_units },
    { .length = 3, .code_units = mal_string_94_code_units },
    { .length = 34, .code_units = mal_string_95_code_units },
    { .length = 1, .code_units = mal_string_96_code_units },
    { .length = 1, .code_units = mal_string_97_code_units },
    { .length = 6, .code_units = mal_string_98_code_units },
    { .length = 4, .code_units = mal_string_99_code_units },
    { .length = 7, .code_units = mal_string_100_code_units },
    { .length = 1, .code_units = mal_string_101_code_units },
    { .length = 9, .code_units = mal_string_102_code_units },
    { .length = 6, .code_units = mal_string_103_code_units },
    { .length = 12, .code_units = mal_string_104_code_units },
    { .length = 1, .code_units = mal_string_105_code_units },
    { .length = 9, .code_units = mal_string_106_code_units },
    { .length = 6, .code_units = mal_string_107_code_units },
    { .length = 5, .code_units = mal_string_108_code_units },
    { .length = 5, .code_units = mal_string_109_code_units },
    { .length = 5, .code_units = mal_string_110_code_units },
    { .length = 3, .code_units = mal_string_111_code_units },
    { .length = 4, .code_units = mal_string_112_code_units },
    { .length = 5, .code_units = mal_string_113_code_units },
    { .length = 4, .code_units = mal_string_114_code_units },
    { .length = 2, .code_units = mal_string_115_code_units },
    { .length = 5, .code_units = mal_string_116_code_units },
    { .length = 15, .code_units = mal_string_117_code_units },
    { .length = 10, .code_units = mal_string_118_code_units },
    { .length = 11, .code_units = mal_string_119_code_units },
    { .length = 10, .code_units = mal_string_120_code_units },
    { .length = 4, .code_units = mal_string_121_code_units },
    { .length = 14, .code_units = mal_string_122_code_units },
    { .length = 17, .code_units = mal_string_123_code_units },
    { .length = 18, .code_units = mal_string_124_code_units },
    { .length = 6, .code_units = mal_string_125_code_units },
    { .length = 14, .code_units = mal_string_126_code_units },
    { .length = 9, .code_units = mal_string_127_code_units },
    { .length = 14, .code_units = mal_string_128_code_units },
    { .length = 3, .code_units = mal_string_129_code_units },
    { .length = 5, .code_units = mal_string_130_code_units },
    { .length = 3, .code_units = mal_string_131_code_units },
    { .length = 3, .code_units = mal_string_132_code_units },
    { .length = 4, .code_units = mal_string_133_code_units },
    { .length = 3, .code_units = mal_string_134_code_units },
    { .length = 6, .code_units = mal_string_135_code_units },
    { .length = 3, .code_units = mal_string_136_code_units },
    { .length = 6, .code_units = mal_string_137_code_units },
    { .length = 7, .code_units = mal_string_138_code_units },
    { .length = 4, .code_units = mal_string_139_code_units },
    { .length = 4, .code_units = mal_string_140_code_units },
    { .length = 9, .code_units = mal_string_141_code_units },
    { .length = 4, .code_units = mal_string_142_code_units },
    { .length = 8, .code_units = mal_string_143_code_units },
    { .length = 3, .code_units = mal_string_144_code_units },
    { .length = 6, .code_units = mal_string_145_code_units },
    { .length = 7, .code_units = mal_string_146_code_units },
    { .length = 1, .code_units = mal_string_147_code_units },
    { .length = 4, .code_units = mal_string_148_code_units },
    { .length = 1, .code_units = mal_string_149_code_units },
    { .length = 5, .code_units = mal_string_150_code_units },
    { .length = 4, .code_units = mal_string_151_code_units },
    { .length = 2, .code_units = mal_string_152_code_units },
    { .length = 3, .code_units = mal_string_153_code_units },
    { .length = 4, .code_units = mal_string_154_code_units },
    { .length = 6, .code_units = mal_string_155_code_units },
    { .length = 11, .code_units = mal_string_156_code_units },
    { .length = 23, .code_units = mal_string_157_code_units },
    { .length = 12, .code_units = mal_string_158_code_units },
    { .length = 12, .code_units = mal_string_159_code_units },
    { .length = 15, .code_units = mal_string_160_code_units },
    { .length = 13, .code_units = mal_string_161_code_units },
    { .length = 11, .code_units = mal_string_162_code_units },
    { .length = 6, .code_units = mal_string_163_code_units },
    { .length = 15, .code_units = mal_string_164_code_units },
    { .length = 11, .code_units = mal_string_165_code_units },
    { .length = 14, .code_units = mal_string_166_code_units },
    { .length = 7, .code_units = mal_string_167_code_units },
    { .length = 18, .code_units = mal_string_168_code_units },
    { .length = 6, .code_units = mal_string_169_code_units },
    { .length = 3, .code_units = mal_string_170_code_units },
    { .length = 4, .code_units = mal_string_171_code_units },
    { .length = 15, .code_units = mal_string_172_code_units },
    { .length = 6, .code_units = mal_string_173_code_units },
    { .length = 4, .code_units = mal_string_174_code_units },
    { .length = 5, .code_units = mal_string_175_code_units },
    { .length = 4, .code_units = mal_string_176_code_units },
    { .length = 9, .code_units = mal_string_177_code_units },
    { .length = 10, .code_units = mal_string_178_code_units },
    { .length = 5, .code_units = mal_string_179_code_units },
    { .length = 3, .code_units = mal_string_180_code_units },
    { .length = 5, .code_units = mal_string_181_code_units },
    { .length = 6, .code_units = mal_string_182_code_units },
    { .length = 5, .code_units = mal_string_183_code_units },
    { .length = 10, .code_units = mal_string_184_code_units },
    { .length = 4, .code_units = mal_string_185_code_units },
    { .length = 5, .code_units = mal_string_186_code_units },
    { .length = 13, .code_units = mal_string_187_code_units },
    { .length = 11, .code_units = mal_string_188_code_units },
    { .length = 4, .code_units = mal_string_189_code_units },
    { .length = 3, .code_units = mal_string_190_code_units },
    { .length = 11, .code_units = mal_string_191_code_units },
    { .length = 1, .code_units = mal_string_192_code_units },
    { .length = 7, .code_units = mal_string_193_code_units },
    { .length = 1, .code_units = mal_string_194_code_units },
    { .length = 1, .code_units = mal_string_195_code_units },
    { .length = 1, .code_units = mal_string_196_code_units },
    { .length = 2, .code_units = mal_string_197_code_units },
    { .length = 6, .code_units = mal_string_198_code_units },
    { .length = 9, .code_units = mal_string_199_code_units },
    { .length = 3, .code_units = mal_string_200_code_units },
    { .length = 12, .code_units = mal_string_201_code_units },
    { .length = 10, .code_units = mal_string_202_code_units },
    { .length = 7, .code_units = mal_string_203_code_units },
    { .length = 37, .code_units = mal_string_204_code_units },
};

static const MalInstruction mal_function_0_instructions[] = {
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 0 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 2 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 5 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 5, .value = 6, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 4 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 5, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 6, .value = 5, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 5 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 5, .value = 6, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 5, .callee = 2, .this_value = 0, .argument_count = 3, .arguments = (const i32[]) { 1, 3, 4 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 3, .value = 2 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 2, .length = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 2, .key = 3, .value = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 2, .key = 4, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 2, .key = 3, .value = 4 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 1 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 6 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 2, .key = 4 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 4, .function_index = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 3, .this_value = 2, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 2 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 2, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 3 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 8 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 3, .key = 4 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 4, .function_index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 0, .this_value = 3, .argument_count = 2, .arguments = (const i32[]) { 4, 2 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 4 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 1, .function_index = 3 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 5 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 6 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 5 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 2 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 1, .this_value = 2, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 65 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 3, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 88 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 11 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 2, .key = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 10 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 3, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 2, .target_ip = 80 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 83 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 10 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 83 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 2, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 88 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 7 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 5, .callee = 3, .this_value = 4, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 97 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 106 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 4, .key = 3 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 106 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 4 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 8 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 8 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 14 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 15 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 7 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 4, .key = 1, .value = 0, .enumerable = true } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 2, .key = 3, .value = 4 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 8 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 3, .callee = 4, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 9 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 16 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 2, .callee = 3, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 10 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 2, .intrinsic = MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 17 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 3, .callee = 2, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 11 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 3, .function_index = 5 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 12 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 3, .key = 4 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 2, .this_value = 3, .argument_count = 3, .arguments = (const i32[]) { 4, 0, 1 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 13 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 20 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 6, .key = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 4, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 5 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 3, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 6 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 4, .key = 2, .value = 3 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 0, .this_value = 6, .argument_count = 2, .arguments = (const i32[]) { 1, 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 14 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 21 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 3, .key = 4 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 1, .this_value = 3, .argument_count = 2, .arguments = (const i32[]) { 4, 6 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 15 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 15 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 7 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 0, .this_value = 6, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 16 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 3 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 1, .key = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 7 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 206 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 211 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 4, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 211 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 9 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 15 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 0, .object = 4, .key = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 10 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 11 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 16 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 224 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 229 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 229 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 10 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 6, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 24 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 236 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 241 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 241 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 11 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 25 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 248 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 253 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 253 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 13 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 14 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 16 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 6, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 0, .key = 6 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 15 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 6, .key = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 3, .key = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 18 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 278 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 283 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 3, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 283 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 18 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 288 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 10 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 1, .right = 3, .op = MAL_BIN_LT } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 293 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 312 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 306 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 7 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 1, .right = 3, .op = MAL_BIN_GT } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 312 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 18 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 1, .index = 18 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 306 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 3, .src = 1, .op = MAL_UNARY_PLUS } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 288 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 19 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 315 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 19 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 4, .right = 1, .op = MAL_BIN_LT } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 3 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 321 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 326 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 18 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 4, .op = MAL_BIN_GT } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 326 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 328 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 334 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 19 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 4, .src = 6, .op = MAL_UNARY_PLUS } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 4, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 19 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 315 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 20 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 337 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 20 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 6, .src = 3, .op = MAL_UNARY_PLUS } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 6, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 20 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 4, .index = 20 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 4, .right = 3, .op = MAL_BIN_LT } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 337 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 26 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 27 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 6, .key = 3 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 4, .this_value = 6, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 28 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 3, .key = 6 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 6, .callee = 4, .this_value = 3, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 21 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 29 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 30 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 6, .key = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 31 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 4, .this_value = 6, .argument_count = 1, .arguments = (const i32[]) { 3 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 22 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 2, .intrinsic = MAL_INTRINSIC_PARSE_INT } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 32 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 5, .callee = 2, .this_value = 3, .argument_count = 2, .arguments = (const i32[]) { 6, 4 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 5, .index = 23 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 5, .intrinsic = MAL_INTRINSIC_NUMBER_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 33 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 5, .key = 4 } },
    { .opcode = MAL_OP_CREATE_F64, .as.create_f64 = { .dst = 4, .value = 3.5e+0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 6, .this_value = 5, .argument_count = 1, .arguments = (const i32[]) { 4 } } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 373 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 376 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 379 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 379 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 4, .index = 24 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 3, .index = 23 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 5, .src = 3, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 5, .index = 25 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 2 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 3, .src = 5, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 34 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 3, .right = 5, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 389 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 392 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 395 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 6, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 395 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 5, .index = 26 } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 6 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 6 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 6, .right = 2, .op = MAL_BIN_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 402 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 405 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 35 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 405 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 3, .index = 27 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 18 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 7, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 19 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 20 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 2, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 6, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 21 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 8, .key = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 7, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 22 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 8, .object = 2, .key = 7 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 6, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 23 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 25 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 8, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 7, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 24 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 26 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 2, .right = 7, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 6, .right = 8, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 27 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 8, .key = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 7, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 17 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 6 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 36 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 6, .key = 2, .value = 7, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 37 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 2 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 6, .key = 7, .value = 2, .enumerable = true } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 28 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 28 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 37 } },
    { .opcode = MAL_OP_DELETE_PROPERTY, .as.delete_property = { .dst = 7, .object = 6, .key = 2 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 29 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 28 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 38 } },
    { .opcode = MAL_OP_DELETE_PROPERTY, .as.delete_property = { .dst = 6, .object = 7, .key = 2 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 30 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 6, .string_index = 36 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 28 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 6, .right = 2, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 467 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 470 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 473 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 473 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 31 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 7, .string_index = 37 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 6, .index = 28 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 7, .right = 6, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 479 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 482 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 485 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 485 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 6, .index = 32 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 39 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 7, .index = 28 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 9, .left = 8, .right = 7, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 9, .target_ip = 491 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 494 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 9, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 9 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 497 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 9, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 9 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 497 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 7, .index = 33 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 9, .length = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 10, .value = 10 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 9, .key = 8, .value = 10 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 10, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 20 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 9, .key = 10, .value = 8 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 10, .value = 30 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 9, .key = 8, .value = 10 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 9, .index = 34 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 9, .index = 34 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 10, .value = 1 } },
    { .opcode = MAL_OP_DELETE_PROPERTY, .as.delete_property = { .dst = 8, .object = 9, .key = 10 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 10, .value = 1 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 9, .index = 34 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 10, .right = 9, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 517 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 520 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 9, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 523 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 9, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 523 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 9, .index = 35 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 34 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 10, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 11, .object = 8, .key = 10 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 11, .index = 36 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 11, .value = 0 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 10, .index = 34 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 11, .right = 10, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 533 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 536 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 10, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 539 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 8, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 10, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 539 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 10, .index = 37 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 8, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 11, .index = 34 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 12, .left = 8, .right = 11, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 12, .target_ip = 545 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 548 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 12, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 11, .src = 12 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 551 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 12, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 11, .src = 12 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 551 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 11, .index = 38 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 12, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 8, .index = 12 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 13, .left = 12, .right = 8, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 13, .target_ip = 557 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 560 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 13, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 13 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 563 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 13, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 8, .src = 13 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 563 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 8, .index = 39 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 13, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 12, .index = 8 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 14, .left = 13, .right = 12, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 14, .target_ip = 569 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 572 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 14, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 12, .src = 14 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 575 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 14, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 12, .src = 14 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 575 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 12, .index = 40 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 14, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 14, .index = 41 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 14, .index = 34 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 13, .string_index = 22 } },
    { .opcode = MAL_OP_DELETE_PROPERTY, .as.delete_property = { .dst = 15, .object = 14, .key = 13 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 15, .target_ip = 584 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 588 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 15, .value = 1 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 13, .src = 15, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 15, .src = 13 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 592 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 13, .value = 2 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 14, .src = 13, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 15, .src = 14 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 592 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 15, .index = 41 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 594 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 608 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 14 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 13, .src = 14 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 14, .src = 13 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 13, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 16, .object = 14, .key = 13 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 13, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 14, .left = 16, .right = 13, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 14, .target_ip = 605 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 608 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 14, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 14, .index = 41 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 608 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 14, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 14, .index = 42 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 14, .string_index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 13, .value = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 16, .left = 14, .right = 13, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 16, .target_ip = 616 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 620 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 16, .value = 1 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 13, .src = 16, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 16, .src = 13 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 624 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 13, .value = 2 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 14, .src = 13, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 16, .src = 14 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 624 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 16, .index = 42 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 626 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 640 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 14 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 13, .src = 14 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 14, .src = 13 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 13, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 17, .object = 14, .key = 13 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 13, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 14, .left = 17, .right = 13, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 14, .target_ip = 637 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 640 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 14, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 14, .index = 42 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 640 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 14, .string_index = 40 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 13, .string_index = 40 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 17, .left = 14, .right = 13, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 17, .target_ip = 645 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 648 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 17, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 13, .src = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 651 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 17, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 13, .src = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 651 } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 17 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 14, .src = 17, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 17, .string_index = 41 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 18, .left = 14, .right = 17, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 18, .target_ip = 657 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 660 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 18, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 17, .src = 18 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 663 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 18, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 17, .src = 18 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 663 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 18, .left = 13, .right = 17, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 14, .value = 1 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 19, .src = 14, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 14, .string_index = 42 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 20, .left = 19, .right = 14, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 20, .target_ip = 670 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 673 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 20, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 14, .src = 20 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 676 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 20, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 14, .src = 20 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 676 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 20, .left = 18, .right = 14, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_CREATE_F64, .as.create_f64 = { .dst = 19, .value = 5.5e+0 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 21, .src = 19, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 19, .string_index = 43 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 22, .left = 21, .right = 19, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 22, .target_ip = 683 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 686 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 22, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 19, .src = 22 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 689 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 22, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 19, .src = 22 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 689 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 22, .left = 20, .right = 19, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 21, .index = 12 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 23, .src = 21, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 21, .string_index = 44 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 24, .left = 23, .right = 21, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 24, .target_ip = 696 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 699 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 24, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 21, .src = 24 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 702 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 24, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 21, .src = 24 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 702 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 24, .left = 22, .right = 21, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 23, .index = 28 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 25, .src = 23, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 23, .string_index = 41 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 26, .left = 25, .right = 23, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 26, .target_ip = 709 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 712 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 26, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 23, .src = 26 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 715 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 26, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 23, .src = 26 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 715 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 26, .left = 24, .right = 23, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 26, .index = 43 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 26, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 25, .index = 29 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 25, .target_ip = 721 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 724 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 25, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 27, .src = 25 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 727 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 25, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 27, .src = 25 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 727 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 25, .index = 30 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 25, .target_ip = 730 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 733 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 25, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 28, .src = 25 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 736 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 25, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 28, .src = 25 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 736 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 25, .left = 27, .right = 28, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 29, .left = 26, .right = 25, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 25, .index = 31 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 30, .index = 32 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 31, .left = 25, .right = 30, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 30, .index = 33 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 25, .left = 31, .right = 30, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 30, .left = 29, .right = 25, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 30, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 30, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 25, .index = 35 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 36 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 31, .left = 25, .right = 29, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 37 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 25, .left = 31, .right = 29, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 38 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 31, .left = 25, .right = 29, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 29, .left = 30, .right = 31, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 31, .index = 39 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 30, .index = 40 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 25, .left = 31, .right = 30, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 30, .left = 29, .right = 25, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 30, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 30, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 25, .index = 41 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 42 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 31, .left = 25, .right = 29, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 29, .left = 30, .right = 31, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 31, .index = 43 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 30, .left = 29, .right = 31, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 30, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 30, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 31, .index = 28 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 29, .string_index = 36 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 25, .object = 31, .key = 29 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 29, .left = 30, .right = 25, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 17 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 29 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 25, .string_index = 45 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 30, .value = 3 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 29, .key = 25, .value = 30, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 30, .string_index = 46 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 25, .function_index = 6 } },
    { .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = 29, .key = 30, .accessor = 25, .is_setter = false, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 25, .string_index = 46 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 30, .function_index = 7 } },
    { .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = 29, .key = 25, .accessor = 30, .is_setter = true, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 30, .string_index = 49 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 25, .function_index = 8 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 29, .key = 30, .value = 25, .enumerable = true } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 44 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 44 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 25, .string_index = 46 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 30, .object = 29, .key = 25 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 30, .index = 45 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 30, .index = 44 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 25, .string_index = 46 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 29, .value = 5 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 30, .key = 25, .value = 29 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 44 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 25, .string_index = 46 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 30, .object = 29, .key = 25 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 30, .index = 46 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 30, .index = 44 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 25, .string_index = 49 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 29, .object = 30, .key = 25 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 25, .value = 3 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 31, .callee = 29, .this_value = 30, .argument_count = 1, .arguments = (const i32[]) { 25 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 31, .index = 47 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 31 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 31, .index = 48 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 31, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 25, .string_index = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 30, .object = 31, .key = 25 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 25, .index = 48 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 29, .string_index = 50 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 32 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 33, .string_index = 51 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 34, .function_index = 9 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 32, .key = 33, .value = 34, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 34, .string_index = 52 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 33, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 32, .key = 34, .value = 33, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 34, .callee = 30, .this_value = 31, .argument_count = 3, .arguments = (const i32[]) { 25, 29, 32 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 48 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 29, .string_index = 50 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 25, .object = 32, .key = 29 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 25, .index = 49 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 25 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 25, .index = 50 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 25, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 29, .string_index = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 32, .object = 25, .key = 29 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 50 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 31, .string_index = 52 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 30 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 33, .string_index = 51 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 34, .function_index = 10 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 30, .key = 33, .value = 34, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 33, .callee = 32, .this_value = 25, .argument_count = 3, .arguments = (const i32[]) { 29, 31, 30 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 30, .index = 50 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 31, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 29, .value = 8 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 30, .key = 31, .value = 29 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 29 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 51 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 29, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 31, .string_index = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 30, .object = 29, .key = 31 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 31, .index = 51 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 25, .string_index = 53 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 50 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 33, .callee = 30, .this_value = 29, .argument_count = 3, .arguments = (const i32[]) { 31, 25, 32 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 51 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 25, .string_index = 53 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 31, .object = 32, .key = 25 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 31, .index = 52 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 31, .index = 51 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 25, .string_index = 53 } },
    { .opcode = MAL_OP_DELETE_PROPERTY, .as.delete_property = { .dst = 32, .object = 31, .key = 25 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 32, .target_ip = 864 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 867 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 32, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 25, .src = 32 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 870 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 32, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 25, .src = 32 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 870 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 25, .index = 53 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 32, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 32, .index = 54 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 48 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 31, .string_index = 50 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 29, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 32, .key = 31, .value = 29 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 879 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 893 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 29 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 31, .src = 29 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 29, .src = 31 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 31, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 32, .object = 29, .key = 31 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 31, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 29, .left = 32, .right = 31, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 29, .target_ip = 890 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 893 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 29, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 54 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 893 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 29 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 55 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 29, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 31, .string_index = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 32, .object = 29, .key = 31 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 31, .index = 55 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 30, .string_index = 54 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 34 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 33, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 35, .value = 2 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 34, .key = 33, .value = 35, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 33, .callee = 32, .this_value = 29, .argument_count = 3, .arguments = (const i32[]) { 31, 30, 34 } } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 34, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 34, .index = 56 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 34, .index = 55 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 30, .string_index = 54 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 31, .value = 9 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 34, .key = 30, .value = 31 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 913 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 927 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 31 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 30, .src = 31 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 31, .src = 30 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 30, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 34, .object = 31, .key = 30 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 30, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 31, .left = 34, .right = 30, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 31, .target_ip = 924 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 927 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 31, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 31, .index = 56 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 927 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 31, .function_index = 11 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 31, .index = 57 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 31, .index = 57 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 30, .string_index = 14 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 34 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 29, .string_index = 56 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 32, .function_index = 12 } },
    { .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = 34, .key = 29, .accessor = 32, .is_setter = false, .enumerable = true } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 31, .key = 30, .value = 34 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 34, .index = 57 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 30, .callee = 34, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 30, .index = 58 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 30, .index = 58 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 34, .string_index = 56 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 31, .object = 30, .key = 34 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 31, .index = 59 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 31, .string_index = 40 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 31, .index = 60 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 31, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 31, .index = 61 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_UNDECLARED, .as.load_undeclared = { .dst = 33, .name_string_index = 58 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 950 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 974 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 31 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 34, .src = 31 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 31, .src = 34 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 30, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 32, .object = 31, .key = 30 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 30, .string_index = 59 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 31, .left = 32, .right = 30, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 30, .src = 31 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 31, .target_ip = 962 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 969 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 31, .src = 34 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 32, .string_index = 11 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 29, .object = 31, .key = 32 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 32, .string_index = 60 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 31, .left = 29, .right = 32, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 30, .src = 31 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 969 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 30, .target_ip = 971 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 974 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 31, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 31, .index = 61 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 974 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 31, .intrinsic = MAL_INTRINSIC_JSON } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 32, .string_index = 61 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 29, .object = 31, .key = 32 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 32 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 35, .string_index = 62 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 33, .function_index = 13 } },
    { .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = 32, .key = 35, .accessor = 33, .is_setter = false, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 33, .callee = 29, .this_value = 31, .argument_count = 1, .arguments = (const i32[]) { 32 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 33, .index = 62 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 33, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 45 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 31, .index = 46 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 29, .left = 32, .right = 31, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 31, .index = 47 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 32, .left = 29, .right = 31, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 31, .left = 33, .right = 32, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 31, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 31, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 49 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 33, .left = 31, .right = 32, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 33, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 33, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 52 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 31, .index = 53 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 29, .left = 32, .right = 31, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 31, .left = 33, .right = 29, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 31, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 31, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 54 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 33, .index = 56 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 32, .left = 29, .right = 33, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 33, .left = 31, .right = 32, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 33, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 33, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 59 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 31, .left = 33, .right = 32, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 31, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 31, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 60 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 33, .string_index = 40 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 29, .left = 32, .right = 33, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 29, .target_ip = 1017 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1020 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 29, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 33, .src = 29 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1023 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 29, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 33, .src = 29 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1023 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 29, .left = 31, .right = 33, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 61 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 35, .left = 29, .right = 32, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 35, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 35, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 62 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 29, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 36, .object = 32, .key = 29 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 29, .left = 35, .right = 36, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 17 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 29, .function_index = 14 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 63 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 63 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 36 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 35, .callee = 29, .this_value = 36, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 35, .index = 64 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 35, .index = 64 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 36 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 32, .callee = 35, .this_value = 36, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 36, .index = 64 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 35 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 32, .callee = 36, .this_value = 35, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 35, .index = 64 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 36 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 29, .callee = 35, .this_value = 36, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 65 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 63 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 36 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 35, .callee = 29, .this_value = 36, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 36 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 29, .callee = 35, .this_value = 36, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 66 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 29, .function_index = 16 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 67 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 67 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 36 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 35, .value = 30 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 32, .callee = 29, .this_value = 36, .argument_count = 1, .arguments = (const i32[]) { 35 } } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 35 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 36, .value = 7 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 29, .callee = 32, .this_value = 35, .argument_count = 1, .arguments = (const i32[]) { 36 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 68 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 29, .function_index = 18 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 29, .index = 69 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 69 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 36 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 35, .value = 7 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 32, .callee = 29, .this_value = 36, .argument_count = 1, .arguments = (const i32[]) { 35 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 32, .index = 70 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 70 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 35, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 36, .value = 40 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 32, .key = 35, .value = 36 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 36, .index = 70 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 35, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 32, .object = 36, .key = 35 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 32, .index = 71 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 35, .index = 65 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 36, .index = 66 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 29, .left = 35, .right = 36, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 36, .left = 32, .right = 29, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 36, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 36, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 68 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 32, .left = 36, .right = 29, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 32, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 71 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 36, .left = 32, .right = 29, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 36, .index = 17 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 36, .function_index = 21 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 36, .owner_function_index = 0, .index = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 29, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 32, .object = 36, .key = 29 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 29, .string_index = 70 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 35, .function_index = 22 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 32, .key = 29, .value = 35, .enumerable = false } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 35, .string_index = 72 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 29, .function_index = 23 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 32, .key = 35, .value = 29, .enumerable = false } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 29, .string_index = 73 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 35, .function_index = 24 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 36, .key = 29, .value = 35, .enumerable = false } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 36, .index = 72 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 36, .index = 72 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 36, .owner_function_index = 0, .index = 1 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 35, .function_index = 25 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 29, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 32, .object = 36, .key = 29 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 37 } },
    { .opcode = MAL_OP_SET_PROTOTYPE, .as.set_prototype = { .object = 37, .prototype = 32, .literal = false } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 32, .string_index = 78 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 37, .key = 32, .value = 35, .enumerable = false } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 35, .key = 29, .value = 37 } },
    { .opcode = MAL_OP_SET_PROTOTYPE, .as.set_prototype = { .object = 35, .prototype = 36, .literal = false } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 36, .string_index = 72 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 29, .function_index = 26 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 37, .key = 36, .value = 29, .enumerable = false } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 29, .string_index = 79 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 36, .function_index = 27 } },
    { .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = 37, .key = 29, .accessor = 36, .is_setter = false, .enumerable = false } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 36, .string_index = 70 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 29, .function_index = 28 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 37, .key = 36, .value = 29, .enumerable = false } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 35, .index = 73 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 35, .index = 73 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 29, .value = 3 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 36, .callee = 35, .argument_count = 1, .arguments = (const i32[]) { 29 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 36, .index = 74 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 36, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 29, .index = 74 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 35, .string_index = 70 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 37, .object = 29, .key = 35 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 35, .callee = 37, .this_value = 29, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 29, .string_index = 81 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 37, .left = 35, .right = 29, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 37, .target_ip = 1144 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 37, .value = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 29, .src = 37 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1150 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 37, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 29, .src = 37 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1150 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 37, .left = 36, .right = 29, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 37, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 37, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 35, .index = 74 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 32, .string_index = 79 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 38, .object = 35, .key = 32 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 32, .left = 37, .right = 38, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 32, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 32, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 38, .index = 74 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 37, .index = 73 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 35, .left = 38, .right = 37, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 37, .src = 35 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 35, .target_ip = 1165 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1170 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 35, .index = 74 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 38, .index = 72 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 39, .left = 35, .right = 38, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 37, .src = 39 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1170 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 37, .target_ip = 1172 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1175 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 39, .value = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 38, .src = 39 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1178 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 39, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 38, .src = 39 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1178 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 39, .left = 32, .right = 38, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 39, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 39, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 35, .index = 72 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 40, .string_index = 73 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 41, .object = 35, .key = 40 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 40, .callee = 41, .this_value = 35, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 35, .string_index = 74 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 41, .left = 40, .right = 35, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 41, .target_ip = 1189 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1192 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 41, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 35, .src = 41 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1195 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 41, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 35, .src = 41 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1195 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 41, .left = 39, .right = 35, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 41, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 41, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 40, .index = 72 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 42, .string_index = 82 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 43, .callee = 40, .argument_count = 1, .arguments = (const i32[]) { 42 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 42, .string_index = 72 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 40, .object = 43, .key = 42 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 42, .callee = 40, .this_value = 43, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 43, .left = 41, .right = 42, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 43, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 43, .index = 73 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 43, .owner_function_index = 0, .index = 2 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 42, .function_index = 29 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 41, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 40, .object = 43, .key = 41 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 44 } },
    { .opcode = MAL_OP_SET_PROTOTYPE, .as.set_prototype = { .object = 44, .prototype = 40, .literal = false } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 40, .string_index = 78 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 44, .key = 40, .value = 42, .enumerable = false } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 42, .key = 41, .value = 44 } },
    { .opcode = MAL_OP_SET_PROTOTYPE, .as.set_prototype = { .object = 42, .prototype = 43, .literal = false } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 43, .value = 2 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 44, .callee = 42, .argument_count = 1, .arguments = (const i32[]) { 43 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 44, .index = 75 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 44, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 43, .index = 75 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 42, .string_index = 79 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 41, .object = 43, .key = 42 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 42, .left = 44, .right = 41, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 42, .index = 17 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 42, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 41, .string_index = 83 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 44, .object = 42, .key = 41 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 41, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 43, .value = 9 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 40, .callee = 44, .this_value = 42, .argument_count = 2, .arguments = (const i32[]) { 41, 43 } } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 43, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 41, .string_index = 84 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 42, .object = 43, .key = 41 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 41, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 44, .value = 5 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 45, .callee = 42, .this_value = 43, .argument_count = 2, .arguments = (const i32[]) { 41, 44 } } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 44, .left = 40, .right = 45, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 45, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 40, .string_index = 85 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 41, .object = 45, .key = 40 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 40, .value = 3 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 43, .src = 40, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 40, .callee = 41, .this_value = 45, .argument_count = 1, .arguments = (const i32[]) { 43 } } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 43, .left = 44, .right = 40, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 40, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 44, .string_index = 86 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 45, .object = 40, .key = 44 } },
    { .opcode = MAL_OP_CREATE_F64, .as.create_f64 = { .dst = 44, .value = 2.9e+0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 41, .callee = 45, .this_value = 40, .argument_count = 1, .arguments = (const i32[]) { 44 } } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 44, .left = 43, .right = 41, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 41, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 43, .string_index = 87 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 40, .object = 41, .key = 43 } },
    { .opcode = MAL_OP_CREATE_F64, .as.create_f64 = { .dst = 43, .value = 2.5e+0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 45, .callee = 40, .this_value = 41, .argument_count = 1, .arguments = (const i32[]) { 43 } } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 43, .left = 44, .right = 45, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 45, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 44, .string_index = 88 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 41, .object = 45, .key = 44 } },
    { .opcode = MAL_OP_CREATE_F64, .as.create_f64 = { .dst = 44, .value = 1.8e+0 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 40, .src = 44, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 44, .callee = 41, .this_value = 45, .argument_count = 1, .arguments = (const i32[]) { 40 } } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 40, .left = 43, .right = 44, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 40, .index = 76 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 40, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 44, .string_index = 89 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 43, .object = 40, .key = 44 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 44, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 45, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 41, .callee = 43, .this_value = 40, .argument_count = 2, .arguments = (const i32[]) { 44, 45 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 41, .index = 77 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 41, .intrinsic = MAL_INTRINSIC_JSON } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 45, .string_index = 61 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 44, .object = 41, .key = 45 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 45 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 40, .string_index = 90 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 43, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 45, .key = 40, .value = 43, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 43, .string_index = 91 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 40, .length = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 42, .value = 0 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 46, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 40, .key = 42, .value = 46 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 46, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 42 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 40, .key = 46, .value = 42 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 42, .value = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 46, .string_index = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 40, .key = 42, .value = 46 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 45, .key = 43, .value = 40, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 40, .callee = 44, .this_value = 41, .argument_count = 1, .arguments = (const i32[]) { 45 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 40, .index = 78 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 40, .intrinsic = MAL_INTRINSIC_JSON } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 45, .string_index = 92 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 41, .object = 40, .key = 45 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 45, .index = 78 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 44, .callee = 41, .this_value = 40, .argument_count = 1, .arguments = (const i32[]) { 45 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 44, .index = 79 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 44, .intrinsic = MAL_INTRINSIC_GLOBAL_THIS } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 45, .string_index = 93 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 40, .object = 44, .key = 45 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 45, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 44, .left = 40, .right = 45, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 44, .target_ip = 1307 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1310 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 44, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 45, .src = 44 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1313 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 44, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 45, .src = 44 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1313 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 45, .index = 80 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 44, .intrinsic = MAL_INTRINSIC_IS_NAN } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 40 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 41, .intrinsic = MAL_INTRINSIC_NAN_VALUE } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 43, .callee = 44, .this_value = 40, .argument_count = 1, .arguments = (const i32[]) { 41 } } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 43, .target_ip = 1320 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1323 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 43, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 41, .src = 43 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1326 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 43, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 41, .src = 43 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1326 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 41, .index = 81 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 43, .intrinsic = MAL_INTRINSIC_INFINITY_VALUE } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 40, .value = 1000000 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 44, .left = 43, .right = 40, .op = MAL_BIN_GT } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 44, .target_ip = 1332 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1335 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 44, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 40, .src = 44 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1338 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 44, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 40, .src = 44 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1338 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 40, .index = 82 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 44, .intrinsic = MAL_INTRINSIC_CONSOLE } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 43, .string_index = 94 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 46, .object = 44, .key = 43 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 43, .string_index = 95 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 42, .index = 77 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 47, .callee = 46, .this_value = 44, .argument_count = 2, .arguments = (const i32[]) { 43, 42 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 42, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 43, .index = 76 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 44, .left = 42, .right = 43, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 44, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 44, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 43, .index = 77 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 42, .left = 44, .right = 43, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 42, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 42, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 43, .index = 78 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 44, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 46, .object = 43, .key = 44 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 44, .left = 42, .right = 46, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 44, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 44, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 46, .index = 79 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 42, .string_index = 91 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 43, .object = 46, .key = 42 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 42, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 46, .object = 43, .key = 42 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 42, .left = 44, .right = 46, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 42, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 42, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 46, .index = 80 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 44, .index = 81 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 43, .left = 46, .right = 44, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 44, .index = 82 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 46, .left = 43, .right = 44, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 44, .left = 42, .right = 46, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 44, .index = 17 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 44 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 46, .string_index = 90 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 42, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 44, .key = 46, .value = 42, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 42, .string_index = 91 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 46, .value = 2 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 44, .key = 42, .value = 46, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 46, .string_index = 96 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 42, .value = 3 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 44, .key = 46, .value = 42, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 42, .string_index = 97 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 46, .value = 4 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 44, .key = 42, .value = 46, .enumerable = true } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 44, .index = 83 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 44, .index = 83 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 44 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 46, .string_index = 90 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 42, .object = 44, .key = 46 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 42, .index = 84 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 42, .string_index = 91 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 43, .object = 44, .key = 42 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 43, .index = 85 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 43, .string_index = 38 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 47, .object = 44, .key = 43 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 48, .src = 47 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 49 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 50, .left = 47, .right = 49, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 50, .target_ip = 1404 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1407 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 50, .value = 9 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 48, .src = 50 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1407 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 48, .index = 86 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 50, .string_index = 96 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 49, .object = 44, .key = 50 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 47, .src = 49 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 51 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 52, .left = 49, .right = 51, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 52, .target_ip = 1415 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1419 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 52, .value = 1 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 51, .src = 52, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 47, .src = 51 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1419 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 47, .index = 87 } },
    { .opcode = MAL_OP_COPY_DATA_PROPERTIES, .as.copy_data_properties = { .dst = 51, .src = 44, .excluded_count = 4, .excluded = (const i32[]) { 46, 42, 43, 50 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 51, .index = 88 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 51, .string_index = 97 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 51, .index = 89 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 51, .index = 83 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 51 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 52, .index = 89 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 49, .object = 51, .key = 52 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 49, .index = 90 } },
    { .opcode = MAL_OP_COPY_DATA_PROPERTIES, .as.copy_data_properties = { .dst = 49, .src = 51, .excluded_count = 1, .excluded = (const i32[]) { 52 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 49, .index = 91 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 49, .length = 5 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 52, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 51, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 49, .key = 52, .value = 51 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 51, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 52, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 49, .key = 51, .value = 52 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 52, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 51, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 49, .key = 52, .value = 51 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 51, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 52, .value = 4 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 49, .key = 51, .value = 52 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 52, .value = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 51, .value = 5 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 49, .key = 52, .value = 51 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 49, .index = 92 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 49, .index = 92 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 51, .next_dst = 52, .source = 49 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 49, .done_dst = 53, .iterator = 51, .next = 52 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 49, .index = 93 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 53, .done_dst = 53, .iterator = 51, .next = 52 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 49, .done_dst = 53, .iterator = 51, .next = 52 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 53, .src = 49 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 54 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 55, .left = 49, .right = 54, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 55, .target_ip = 1459 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1463 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 55, .value = 1 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 54, .src = 55, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 53, .src = 54 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1463 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 53, .index = 94 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 54, .done_dst = 49, .iterator = 51, .next = 52 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 55, .src = 54 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 49 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 56, .left = 54, .right = 49, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 56, .target_ip = 1470 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1473 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 56, .value = 8 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 55, .src = 56 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1473 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 55, .index = 95 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 56, .length = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 49, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 54, .value = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1478 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 57, .done_dst = 58, .iterator = 51, .next = 52 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 58, .target_ip = 1483 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 56, .key = 49, .value = 57 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 49, .left = 49, .right = 54, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1478 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 56, .index = 96 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 57, .length = 0 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 58, .next_dst = 59, .source = 57 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 57, .done_dst = 60, .iterator = 58, .next = 59 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 59, .src = 57 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 61 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 62, .left = 57, .right = 61, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 62, .target_ip = 1492 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1495 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 62, .value = 6 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 59, .src = 62 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1495 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 59, .index = 97 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 60, .target_ip = 1499 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 58 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1499 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 62, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 61, .value = 0 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 57, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 63, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 64, .value = 7 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 57, .key = 63, .value = 64 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 64, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 63, .value = 8 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 57, .key = 64, .value = 63 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 62, .key = 61, .value = 57 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 57, .next_dst = 61, .source = 62 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 62, .done_dst = 64, .iterator = 57, .next = 61 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 63, .next_dst = 64, .source = 62 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 62, .done_dst = 65, .iterator = 63, .next = 64 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 62, .index = 98 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 62, .done_dst = 65, .iterator = 63, .next = 64 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 62, .index = 99 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 65, .target_ip = 1519 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 63 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1519 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 63, .done_dst = 65, .iterator = 57, .next = 61 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 62, .src = 63 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 64 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 66, .left = 63, .right = 64, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 66, .target_ip = 1525 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1528 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 66, .length = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 62, .src = 66 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1528 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 66, .next_dst = 64, .source = 62 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 63, .done_dst = 67, .iterator = 66, .next = 64 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 67, .src = 63 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 68 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 69, .left = 63, .right = 68, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 69, .target_ip = 1535 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1538 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 69, .value = 20 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 67, .src = 69 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1538 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 67, .index = 100 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 69, .done_dst = 68, .iterator = 66, .next = 64 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 63, .src = 69 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 70 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 71, .left = 69, .right = 70, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 71, .target_ip = 1545 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1548 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 71, .value = 30 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 63, .src = 71 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1548 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 63, .index = 101 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 68, .target_ip = 1552 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 66 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1552 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 65, .target_ip = 1555 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 57 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1555 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 71 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 71 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 70, .string_index = 98 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 69, .object = 71, .key = 70 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 70, .src = 69 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 71 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 72, .left = 69, .right = 71, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 72, .target_ip = 1564 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1567 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 72 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 70, .src = 72 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1567 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 70 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 72, .string_index = 99 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 71, .object = 70, .key = 72 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 72, .src = 71 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 69 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 73, .left = 71, .right = 69, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 73, .target_ip = 1575 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1578 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 73, .value = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 72, .src = 73 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1578 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 72, .index = 102 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 73, .function_index = 30 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 73, .index = 103 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 73, .function_index = 31 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 73, .index = 104 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 73, .function_index = 32 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 73, .index = 105 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 73, .function_index = 33 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 73, .index = 106 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 73, .function_index = 35 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 73, .index = 107 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 73, .function_index = 36 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 73, .index = 108 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 73, .index = 103 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 69 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 71 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 74, .string_index = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 75, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 71, .key = 74, .value = 75, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 75, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 74, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 76, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 75, .key = 74, .value = 76 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 76 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 74, .value = 7 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 77, .value = 8 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 78, .value = 9 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 79, .callee = 73, .this_value = 69, .argument_count = 6, .arguments = (const i32[]) { 71, 75, 76, 74, 77, 78 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 79, .index = 109 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 79, .index = 104 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 78 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 77, .value = 5 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 74, .value = 6 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 76, .callee = 79, .this_value = 78, .argument_count = 2, .arguments = (const i32[]) { 77, 74 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 76, .index = 110 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 76, .index = 104 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 74 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 77, .callee = 76, .this_value = 74, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 77, .index = 111 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 77, .index = 105 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 74 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 76, .value = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 78, .callee = 77, .this_value = 74, .argument_count = 1, .arguments = (const i32[]) { 76 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 78, .index = 112 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 78, .index = 105 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 76 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 74, .value = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 77 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 79, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 75, .callee = 78, .this_value = 76, .argument_count = 3, .arguments = (const i32[]) { 74, 77, 79 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 75, .index = 113 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 75, .index = 105 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 79 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 77, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 74, .value = 5 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 76, .callee = 75, .this_value = 79, .argument_count = 2, .arguments = (const i32[]) { 77, 74 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 76, .index = 114 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 76, .index = 106 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 74 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 77, .value = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 79, .callee = 76, .this_value = 74, .argument_count = 1, .arguments = (const i32[]) { 77 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 79, .index = 115 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 79, .index = 107 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 77 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 74, .value = 5 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 76, .callee = 79, .this_value = 77, .argument_count = 1, .arguments = (const i32[]) { 74 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 76, .index = 116 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 76, .index = 108 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 74 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 77 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 79, .callee = 76, .this_value = 74, .argument_count = 1, .arguments = (const i32[]) { 77 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 79, .index = 117 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 79, .function_index = 37 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 79, .index = 118 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 79, .function_index = 38 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 79, .index = 119 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 79, .function_index = 39 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 79, .index = 120 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 79, .index = 118 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 77, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 74, .object = 79, .key = 77 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 77, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 79, .left = 74, .right = 77, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 79, .target_ip = 1663 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1666 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 79, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 77, .src = 79 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1669 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 79, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 77, .src = 79 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1669 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 79, .index = 119 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 74, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 76, .object = 79, .key = 74 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 74, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 79, .left = 76, .right = 74, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 79, .target_ip = 1676 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1679 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 79, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 74, .src = 79 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1682 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 79, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 74, .src = 79 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1682 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 79, .left = 77, .right = 74, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 76, .index = 120 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 75, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 78, .object = 76, .key = 75 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 75, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 76, .left = 78, .right = 75, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 76, .target_ip = 1690 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1693 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 76, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 75, .src = 76 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1696 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 76, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 75, .src = 76 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1696 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 76, .left = 79, .right = 75, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 78, .index = 103 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 71, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 69, .object = 78, .key = 71 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 71, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 78, .left = 69, .right = 71, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 78, .target_ip = 1704 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1707 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 78, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 71, .src = 78 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1710 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 78, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 71, .src = 78 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1710 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 78, .left = 76, .right = 71, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 69, .index = 105 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 73, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 80, .object = 69, .key = 73 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 73, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 69, .left = 80, .right = 73, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 69, .target_ip = 1718 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1721 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 69, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 73, .src = 69 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1724 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 69, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 73, .src = 69 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1724 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 69, .left = 78, .right = 73, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 69, .index = 121 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 69, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 69, .index = 122 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 69, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 69, .index = 123 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 69, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 80, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 81, .value = 30 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 69, .key = 80, .value = 81 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 81, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 80, .value = 40 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 69, .key = 81, .value = 80 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 80, .next_dst = 81, .source = 69 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 69, .done_dst = 82, .iterator = 80, .next = 81 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 69, .index = 122 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 69, .done_dst = 82, .iterator = 80, .next = 81 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 69, .index = 123 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 82, .target_ip = 1745 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 80 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1745 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 80 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 82, .string_index = 111 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 69, .value = 7 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 80, .key = 82, .value = 69, .enumerable = true } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 80 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 69, .string_index = 111 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 82, .object = 80, .key = 69 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 82, .index = 122 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 82 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 82, .index = 124 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 82, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 69, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 80, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 82, .key = 69, .value = 80 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 80, .next_dst = 69, .source = 82 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 82, .done_dst = 81, .iterator = 80, .next = 69 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 81, .index = 124 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 83, .string_index = 112 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 81, .key = 83, .value = 82 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 82, .done_dst = 83, .iterator = 80, .next = 69 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 69, .src = 82 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 81 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 84, .left = 82, .right = 81, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 84, .target_ip = 1770 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1773 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 84, .value = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 69, .src = 84 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1773 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 84, .index = 124 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 81, .string_index = 113 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 84, .key = 81, .value = 69 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 83, .target_ip = 1779 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 80 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1779 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 81, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 84, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 82, .value = 9 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 81, .key = 84, .value = 82 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 82, .next_dst = 84, .source = 81 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 85, .done_dst = 86, .iterator = 82, .next = 84 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 85, .index = 123 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 86, .target_ip = 1789 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 82 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1789 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 81, .index = 125 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 82, .string_index = 114 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 86, .next_dst = 85, .source = 82 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 82, .done_dst = 84, .iterator = 86, .next = 85 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 82, .index = 126 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 82, .done_dst = 84, .iterator = 86, .next = 85 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 82, .index = 127 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 82, .length = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 84, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 87, .value = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1800 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 88, .done_dst = 89, .iterator = 86, .next = 85 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 89, .target_ip = 1805 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 82, .key = 84, .value = 88 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 84, .left = 84, .right = 87, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1800 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 82, .index = 128 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 88, .string_index = 115 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 88 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 89, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 90, .object = 88, .key = 89 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 90, .index = 129 } },
    { .opcode = MAL_OP_COPY_DATA_PROPERTIES, .as.copy_data_properties = { .dst = 90, .src = 88, .excluded_count = 1, .excluded = (const i32[]) { 89 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 90, .index = 130 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 90, .string_index = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 90, .index = 131 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 90, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 89, .string_index = 116 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 88, .callee = 90, .argument_count = 1, .arguments = (const i32[]) { 89 } } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 88 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1845 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 88 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 88 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 89, .string_index = 11 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 90, .object = 88, .key = 89 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 89, .src = 90 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 90, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 91, .object = 88, .key = 90 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 90, .src = 91 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 88 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 92, .left = 91, .right = 88, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 92, .target_ip = 1834 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1837 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 92, .string_index = 35 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 90, .src = 92 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1837 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 92, .src = 90 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 88, .src = 92 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 92, .string_index = 71 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 91, .left = 88, .right = 92, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 92, .src = 89 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 88, .left = 91, .right = 92, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 88, .index = 131 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1845 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 88, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 88, .index = 132 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 88 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 88 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 92, .string_index = 16 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 91, .object = 88, .key = 92 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 88, .src = 91 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1854 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1868 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 91 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 92, .src = 91 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 91, .src = 92 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 92, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 88, .object = 91, .key = 92 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 92, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 91, .left = 88, .right = 92, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 91, .target_ip = 1865 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1868 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 91, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 91, .index = 132 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1868 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 91, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 91, .index = 133 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 91 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 91 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1874 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1888 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 91 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 92, .src = 91 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 91, .src = 92 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 92, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 88, .object = 91, .key = 92 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 92, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 91, .left = 88, .right = 92, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 91, .target_ip = 1885 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1888 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 91, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 91, .index = 133 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1888 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 91, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 91, .index = 134 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 91 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 92, .next_dst = 88, .source = 91 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 92 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1895 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1909 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 92 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 91, .src = 92 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 92, .src = 91 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 91, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 88, .object = 92, .key = 91 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 91, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 92, .left = 88, .right = 91, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 92, .target_ip = 1906 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1909 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 92, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 92, .index = 134 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1909 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 92, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 91, .index = 84 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 88, .index = 85 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 93, .left = 91, .right = 88, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 88, .index = 86 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 91, .left = 93, .right = 88, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 88, .index = 87 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 93, .left = 91, .right = 88, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 88, .left = 92, .right = 93, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 88, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 88, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 93, .index = 88 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 92, .string_index = 97 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 91, .object = 93, .key = 92 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 92, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 93, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 94, .object = 92, .key = 93 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 93, .index = 88 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 95, .callee = 94, .this_value = 92, .argument_count = 1, .arguments = (const i32[]) { 93 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 93, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 92, .object = 95, .key = 93 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 93, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 95, .left = 92, .right = 93, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 95, .target_ip = 1936 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1939 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 95, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 93, .src = 95 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1942 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 95, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 93, .src = 95 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 1942 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 95, .left = 91, .right = 93, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 92, .left = 88, .right = 95, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 95, .index = 90 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 94, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 96, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 97, .object = 94, .key = 96 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 96, .index = 91 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 98, .callee = 97, .this_value = 94, .argument_count = 1, .arguments = (const i32[]) { 96 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 96, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 94, .object = 98, .key = 96 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 96, .left = 95, .right = 94, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 94, .left = 92, .right = 96, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 94, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 94, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 96, .index = 93 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 94 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 95, .left = 96, .right = 92, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 95 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 96, .left = 95, .right = 92, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 92, .left = 94, .right = 96, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 96, .index = 96 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 94, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 95, .object = 96, .key = 94 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 94, .index = 96 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 96, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 98, .object = 94, .key = 96 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 96, .left = 95, .right = 98, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 98, .left = 92, .right = 96, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 98, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 98, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 96, .index = 97 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 92, .left = 98, .right = 96, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 96, .index = 98 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 98, .index = 99 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 95, .left = 96, .right = 98, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 98, .index = 100 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 96, .left = 95, .right = 98, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 98, .index = 101 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 95, .left = 96, .right = 98, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 98, .left = 92, .right = 95, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 98, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 98, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 95, .index = 102 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 92, .left = 98, .right = 95, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 95, .index = 109 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 98, .left = 92, .right = 95, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 98, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 98, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 95, .index = 110 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 111 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 96, .left = 95, .right = 92, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 92, .left = 98, .right = 96, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 96, .index = 112 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 98, .index = 113 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 95, .left = 96, .right = 98, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 98, .index = 114 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 96, .left = 95, .right = 98, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 98, .left = 92, .right = 96, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 98, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 98, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 96, .index = 115 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 92, .left = 98, .right = 96, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 96, .index = 116 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 98, .left = 92, .right = 96, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 98, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 98, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 96, .index = 117 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 92, .left = 98, .right = 96, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 96, .index = 121 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 98, .left = 92, .right = 96, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 98, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 98, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 96, .index = 122 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 123 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 95, .left = 96, .right = 92, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 92, .left = 98, .right = 95, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 95, .index = 124 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 98, .string_index = 112 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 96, .object = 95, .key = 98 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 98, .index = 124 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 95, .string_index = 113 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 94, .object = 98, .key = 95 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 95, .left = 96, .right = 94, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 94, .left = 92, .right = 95, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 94, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 94, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 95, .index = 125 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 92, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 96, .object = 95, .key = 92 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 125 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 95, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 98, .object = 92, .key = 95 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 95, .left = 96, .right = 98, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 98, .left = 94, .right = 95, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 98, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 98, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 95, .index = 126 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 94, .string_index = 90 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 96, .left = 95, .right = 94, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 94, .src = 96 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 96, .target_ip = 2060 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2065 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 96, .index = 127 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 95, .string_index = 91 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 92, .left = 96, .right = 95, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 94, .src = 92 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2065 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 94, .target_ip = 2067 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2070 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 92, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 95, .src = 92 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2073 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 92, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 95, .src = 92 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2073 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 92, .left = 98, .right = 95, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 92, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 96, .index = 128 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 97, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 99, .object = 96, .key = 97 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 97, .index = 128 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 96, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 100, .object = 97, .key = 96 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 96, .string_index = 97 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 97, .left = 100, .right = 96, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 97, .target_ip = 2086 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2089 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 97, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 96, .src = 97 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2092 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 97, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 96, .src = 97 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2092 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 97, .left = 99, .right = 96, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 100, .left = 92, .right = 97, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 100, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 100, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 97, .index = 129 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 101, .string_index = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 102, .left = 97, .right = 101, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 102, .target_ip = 2101 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2104 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 102, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 101, .src = 102 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2107 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 102, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 101, .src = 102 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2107 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 102, .left = 100, .right = 101, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 102, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 102, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 97, .index = 130 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 103, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 104, .object = 97, .key = 103 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 103, .string_index = 101 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 97, .left = 104, .right = 103, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 103, .src = 97 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 97, .target_ip = 2118 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2129 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 97, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 104, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 105, .object = 97, .key = 104 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 104, .index = 130 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 106, .callee = 105, .this_value = 97, .argument_count = 1, .arguments = (const i32[]) { 104 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 104, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 97, .object = 106, .key = 104 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 104, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 106, .left = 97, .right = 104, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 103, .src = 106 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2129 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 103, .target_ip = 2131 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2134 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 106, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 104, .src = 106 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2137 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 106, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 104, .src = 106 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2137 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 106, .left = 102, .right = 104, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 106, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 106, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 97, .index = 131 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 105, .string_index = 117 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 107, .left = 97, .right = 105, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 107, .target_ip = 2145 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2148 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 107, .value = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 105, .src = 107 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2151 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 107, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 105, .src = 107 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2151 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 107, .left = 106, .right = 105, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 107, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 107, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 97, .index = 132 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 108, .index = 133 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 109, .left = 97, .right = 108, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 108, .index = 134 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 97, .left = 109, .right = 108, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 108, .left = 107, .right = 97, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 108, .index = 135 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 108, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 97, .index = 135 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 107, .left = 108, .right = 97, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 107, .index = 17 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 107, .function_index = 40 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 107, .index = 136 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 107, .function_index = 41 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 107, .index = 137 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 107, .function_index = 42 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 107, .owner_function_index = 0, .index = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 97, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 109, .object = 107, .key = 97 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 107, .index = 138 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 107 } },
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 107 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 97, .string_index = 121 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 108, .object = 107, .key = 97 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 97, .src = 108 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 107 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 109, .left = 108, .right = 107, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 109, .target_ip = 2183 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2186 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 109, .function_index = 43 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 97, .src = 109 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2186 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 97, .index = 139 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 109 } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 107 } },
    { .opcode = MAL_OP_SET_PROTOTYPE, .as.set_prototype = { .object = 109, .prototype = 107, .literal = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 107, .string_index = 90 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 108, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 109, .key = 107, .value = 108, .enumerable = true } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 109, .index = 140 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 109 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 108, .value = 5 } },
    { .opcode = MAL_OP_SET_PROTOTYPE, .as.set_prototype = { .object = 109, .prototype = 108, .literal = true } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 109, .index = 141 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 109, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 109, .index = 142 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 109, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 108, .string_index = 122 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 107, .object = 109, .key = 108 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 108, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 110, .string_index = 123 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 111, .object = 108, .key = 110 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 110 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 112, .callee = 111, .this_value = 108, .argument_count = 1, .arguments = (const i32[]) { 110 } } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 110 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 108, .string_index = 90 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 111, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 110, .key = 108, .value = 111, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 108, .callee = 107, .this_value = 109, .argument_count = 2, .arguments = (const i32[]) { 112, 110 } } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2215 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2229 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 110 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 112, .src = 110 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 110, .src = 112 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 112, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 109, .object = 110, .key = 112 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 112, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 110, .left = 109, .right = 112, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 110, .target_ip = 2226 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2229 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 110, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 110, .index = 142 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2229 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 110, .intrinsic = MAL_INTRINSIC_JSON } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 112, .string_index = 92 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 109, .object = 110, .key = 112 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 112, .string_index = 124 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 107, .callee = 109, .this_value = 110, .argument_count = 1, .arguments = (const i32[]) { 112 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 107, .index = 143 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 107, .length = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 112, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 110, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 107, .key = 112, .value = 110 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 110, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 112, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 107, .key = 110, .value = 112 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 112, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 110, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 107, .key = 112, .value = 110 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 107, .index = 144 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 107, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 110, .string_index = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 112, .object = 107, .key = 110 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 110, .index = 144 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 109, .string_index = 22 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 111 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 108, .string_index = 4 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 113, .value = 0 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 111, .key = 108, .value = 113, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 108, .callee = 112, .this_value = 107, .argument_count = 3, .arguments = (const i32[]) { 110, 109, 111 } } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 111, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 111, .index = 145 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 111, .index = 144 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 109, .string_index = 125 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 110, .object = 111, .key = 109 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 109, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 107, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 112, .value = 9 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 108, .callee = 110, .this_value = 111, .argument_count = 3, .arguments = (const i32[]) { 109, 107, 112 } } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2267 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2281 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 112 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 107, .src = 112 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 112, .src = 107 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 107, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 109, .object = 112, .key = 107 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 107, .string_index = 23 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 112, .left = 109, .right = 107, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 112, .target_ip = 2278 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2281 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 112, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 112, .index = 145 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2281 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 112, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 112, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 112, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 107, .index = 136 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 109, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 111, .object = 107, .key = 109 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 109, .string_index = 118 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 107, .left = 111, .right = 109, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 107, .target_ip = 2291 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2294 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 107, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 109, .src = 107 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2297 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 107, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 109, .src = 107 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2297 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 107, .left = 112, .right = 109, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 107, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 107, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 111, .index = 137 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 110, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 113, .object = 111, .key = 110 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 110, .string_index = 119 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 111, .left = 113, .right = 110, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 111, .target_ip = 2307 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2310 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 111, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 110, .src = 111 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2313 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 111, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 110, .src = 111 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2313 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 111, .left = 107, .right = 110, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 111, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 111, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 113, .index = 138 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 108, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 114, .object = 113, .key = 108 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 108, .string_index = 120 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 113, .left = 114, .right = 108, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 113, .target_ip = 2323 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2326 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 113, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 108, .src = 113 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2329 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 113, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 108, .src = 113 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2329 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 113, .left = 111, .right = 108, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 113, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 113, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 114, .index = 139 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 115, .string_index = 12 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 116, .object = 114, .key = 115 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 115, .string_index = 121 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 114, .left = 116, .right = 115, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 114, .target_ip = 2339 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2342 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 114, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 115, .src = 114 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2345 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 114, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 115, .src = 114 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2345 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 114, .left = 113, .right = 115, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 114, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 114, .index = 146 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 116, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 117, .string_index = 126 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 118, .object = 116, .key = 117 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 117, .index = 140 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 119, .callee = 118, .this_value = 116, .argument_count = 1, .arguments = (const i32[]) { 117 } } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 117 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 116, .left = 119, .right = 117, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 116, .target_ip = 2357 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2360 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 116, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 117, .src = 116 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2363 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 116, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 117, .src = 116 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2363 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 116, .left = 114, .right = 117, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 116, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 116, .index = 146 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 119, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 118, .string_index = 126 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 120, .object = 119, .key = 118 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 118, .index = 141 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 121, .callee = 120, .this_value = 119, .argument_count = 1, .arguments = (const i32[]) { 118 } } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 118, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 119, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 120, .object = 118, .key = 119 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 119, .left = 121, .right = 120, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 119, .target_ip = 2377 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2380 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 119, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 120, .src = 119 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2383 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 119, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 120, .src = 119 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2383 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 119, .left = 116, .right = 120, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 119, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 119, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 121, .index = 142 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 118, .left = 119, .right = 121, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 118, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 118, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 121, .index = 143 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 119, .string_index = 127 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 122, .object = 121, .key = 119 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 119, .value = 7 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 121, .left = 122, .right = 119, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 121, .target_ip = 2397 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2400 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 121, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 119, .src = 121 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2403 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 121, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 119, .src = 121 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2403 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 121, .left = 118, .right = 119, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 121, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 121, .index = 146 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 122 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 123, .string_index = 128 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 124, .object = 122, .key = 123 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 123, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 122, .object = 124, .key = 123 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 123, .index = 143 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 125, .string_index = 127 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 126, .callee = 122, .this_value = 124, .argument_count = 2, .arguments = (const i32[]) { 123, 125 } } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 126, .target_ip = 2416 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2419 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 126, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 125, .src = 126 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2422 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 126, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 125, .src = 126 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2422 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 126, .left = 121, .right = 125, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 126, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 126, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 123, .index = 145 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 124, .left = 126, .right = 123, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 124, .index = 146 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 124, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 123, .index = 146 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 126, .left = 124, .right = 123, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 126, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 126, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 126, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 126, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 123, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 124, .value = 0 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 122, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 127, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 128, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 122, .key = 127, .value = 128 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 128, .value = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 127, .string_index = 129 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 122, .key = 128, .value = 127 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 123, .key = 124, .value = 122 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 122, .value = 1 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 124, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 127, .value = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 128, .string_index = 90 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 124, .key = 127, .value = 128 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 128, .value = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 127, .string_index = 130 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 124, .key = 128, .value = 127 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 123, .key = 122, .value = 124 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 124, .callee = 126, .argument_count = 1, .arguments = (const i32[]) { 123 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 124, .index = 148 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 124, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 123, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 126, .string_index = 131 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 122, .object = 123, .key = 126 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 126, .intrinsic = MAL_INTRINSIC_NAN_VALUE } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 127, .string_index = 132 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 128, .callee = 122, .this_value = 123, .argument_count = 2, .arguments = (const i32[]) { 126, 127 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 127, .index = 148 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 126, .left = 128, .right = 127, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 126, .target_ip = 2467 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2470 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 126, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 127, .src = 126 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2473 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 126, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 127, .src = 126 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2473 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 126, .left = 124, .right = 127, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 126, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 126, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 128, .string_index = 131 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 123, .object = 126, .key = 128 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 128, .value = 0 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 122, .src = 128, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 128, .string_index = 133 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 129, .callee = 123, .this_value = 126, .argument_count = 2, .arguments = (const i32[]) { 122, 128 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 128, .string_index = 131 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 122, .object = 129, .key = 128 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 128, .value = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 126, .string_index = 134 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 123, .callee = 122, .this_value = 129, .argument_count = 2, .arguments = (const i32[]) { 128, 126 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 126, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 128, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 129, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 122, .object = 128, .key = 129 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 129, .value = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 128, .left = 122, .right = 129, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 128, .target_ip = 2495 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2498 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 128, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 129, .src = 128 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2501 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 128, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 129, .src = 128 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2501 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 128, .left = 126, .right = 129, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 128, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 128, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 122, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 123, .string_index = 51 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 130, .object = 122, .key = 123 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 123, .value = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 131, .callee = 130, .this_value = 122, .argument_count = 1, .arguments = (const i32[]) { 123 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 123, .string_index = 129 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 122, .left = 131, .right = 123, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 122, .target_ip = 2513 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2516 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 122, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 123, .src = 122 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2519 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 122, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 123, .src = 122 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2519 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 122, .left = 128, .right = 123, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 122, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 122, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 131, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 130, .string_index = 51 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 132, .object = 131, .key = 130 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 130, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 133, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 134, .left = 130, .right = 133, .op = MAL_BIN_DIV } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 133, .callee = 132, .this_value = 131, .argument_count = 1, .arguments = (const i32[]) { 134 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 134, .string_index = 132 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 131, .left = 133, .right = 134, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 131, .target_ip = 2533 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2536 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 131, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 134, .src = 131 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2539 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 131, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 134, .src = 131 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2539 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 131, .left = 122, .right = 134, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 131, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 131, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 133, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 132, .string_index = 51 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 130, .object = 133, .key = 132 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 132, .value = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 135, .callee = 130, .this_value = 133, .argument_count = 1, .arguments = (const i32[]) { 132 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 132, .string_index = 133 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 133, .left = 135, .right = 132, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 133, .target_ip = 2551 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2554 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 133, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 132, .src = 133 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2557 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 133, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 132, .src = 133 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2557 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 133, .left = 131, .right = 132, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 133, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 133, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 135, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 130, .string_index = 135 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 136, .object = 135, .key = 130 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 130, .value = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 137, .callee = 136, .this_value = 135, .argument_count = 1, .arguments = (const i32[]) { 130 } } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 130, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 135, .left = 137, .right = 130, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 135, .target_ip = 2569 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2572 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 135, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 130, .src = 135 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2575 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 135, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 130, .src = 135 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2575 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 135, .left = 133, .right = 130, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 135, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 135, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 137, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 136, .string_index = 136 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 138, .object = 137, .key = 136 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 136, .value = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 139, .callee = 138, .this_value = 137, .argument_count = 1, .arguments = (const i32[]) { 136 } } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 136, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 137, .left = 139, .right = 136, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 137, .target_ip = 2587 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2590 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 137, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 136, .src = 137 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2593 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 137, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 136, .src = 137 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2593 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 137, .left = 135, .right = 136, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 137, .index = 147 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 137, .length = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 137, .index = 149 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 137, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 139, .string_index = 131 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 138, .object = 137, .key = 139 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 139, .string_index = 90 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 140, .string_index = 137 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 141, .callee = 138, .this_value = 137, .argument_count = 2, .arguments = (const i32[]) { 139, 140 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 140, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 139, .string_index = 138 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 137, .object = 140, .key = 139 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 139, .function_index = 44 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 141, .callee = 137, .this_value = 140, .argument_count = 1, .arguments = (const i32[]) { 139 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 139, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 140, .index = 149 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 137, .string_index = 140 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 138, .object = 140, .key = 137 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 137, .string_index = 31 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 141, .callee = 138, .this_value = 140, .argument_count = 1, .arguments = (const i32[]) { 137 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 137, .string_index = 141 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 140, .left = 141, .right = 137, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 140, .target_ip = 2618 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2621 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 140, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 137, .src = 140 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2624 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 140, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 137, .src = 140 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2624 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 140, .left = 139, .right = 137, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 140, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 140, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 141, .intrinsic = MAL_INTRINSIC_STRING_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 138 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 142, .index = 148 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 143, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 144, .object = 142, .key = 143 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 143, .callee = 144, .this_value = 142, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 142, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 144, .object = 143, .key = 142 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 142, .callee = 144, .this_value = 143, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 143, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 144, .object = 142, .key = 143 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 143, .callee = 141, .this_value = 138, .argument_count = 1, .arguments = (const i32[]) { 144 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 144, .string_index = 90 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 138, .left = 143, .right = 144, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 138, .target_ip = 2643 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2646 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 138, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 144, .src = 138 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2649 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 138, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 144, .src = 138 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2649 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 138, .left = 140, .right = 144, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 138, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 138, .index = 148 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 143, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 141, .string_index = 143 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 142, .object = 143, .key = 141 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 141, .object = 138, .key = 142 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 142, .callee = 141, .this_value = 138, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 138, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 141, .object = 142, .key = 138 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 138, .callee = 141, .this_value = 142, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 142, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 141, .object = 138, .key = 142 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 141, .index = 150 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 141, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 142, .index = 150 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 138, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 143, .object = 142, .key = 138 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 138, .string_index = 90 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 142, .left = 143, .right = 138, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 138, .src = 142 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 142, .target_ip = 2672 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2679 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 142, .index = 150 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 143, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 145, .object = 142, .key = 143 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 143, .string_index = 137 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 142, .left = 145, .right = 143, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 138, .src = 142 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2679 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 138, .target_ip = 2681 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2684 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 142, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 143, .src = 142 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2687 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 142, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 143, .src = 142 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2687 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 142, .left = 141, .right = 143, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 142, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 142, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 145, .length = 6 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 146, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 147, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 145, .key = 146, .value = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 147, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 146, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 145, .key = 147, .value = 146 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 146, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 147, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 145, .key = 146, .value = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 147, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 146, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 145, .key = 147, .value = 146 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 146, .value = 4 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 147, .intrinsic = MAL_INTRINSIC_NAN_VALUE } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 145, .key = 146, .value = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 147, .value = 5 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 146, .intrinsic = MAL_INTRINSIC_NAN_VALUE } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 145, .key = 147, .value = 146 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 146, .callee = 142, .argument_count = 1, .arguments = (const i32[]) { 145 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 146, .index = 151 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 146, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 145, .index = 151 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 142, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 147, .object = 145, .key = 142 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 142, .value = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 145, .left = 147, .right = 142, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 145, .target_ip = 2719 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2722 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 145, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 142, .src = 145 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2725 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 145, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 142, .src = 145 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2725 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 145, .left = 146, .right = 142, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 145, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 145, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 147, .index = 151 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 148, .string_index = 144 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 149, .object = 147, .key = 148 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 148, .value = 3 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 150, .callee = 149, .this_value = 147, .argument_count = 1, .arguments = (const i32[]) { 148 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 148, .index = 151 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 147, .left = 150, .right = 148, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 147, .target_ip = 2737 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2740 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 147, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 148, .src = 147 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2743 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 147, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 148, .src = 147 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2743 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 147, .left = 145, .right = 148, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 147, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 147, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 150, .index = 151 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 149, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 151, .object = 150, .key = 149 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 149, .value = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 150, .left = 151, .right = 149, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 150, .target_ip = 2753 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2756 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 150, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 149, .src = 150 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2759 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 150, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 149, .src = 150 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2759 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 150, .left = 147, .right = 149, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 150, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 150, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 151, .index = 151 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 152, .string_index = 136 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 153, .object = 151, .key = 152 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 152, .intrinsic = MAL_INTRINSIC_NAN_VALUE } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 154, .callee = 153, .this_value = 151, .argument_count = 1, .arguments = (const i32[]) { 152 } } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 154, .target_ip = 2769 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2772 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 154, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 152, .src = 154 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2775 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 154, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 152, .src = 154 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2775 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 154, .left = 150, .right = 152, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 154, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 154, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 151, .index = 151 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 153, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 155, .object = 151, .key = 153 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 153, .index = 151 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 151, .string_index = 145 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 156, .object = 153, .key = 151 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 151, .left = 155, .right = 156, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 151, .target_ip = 2787 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2790 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 151, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 156, .src = 151 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2793 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 151, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 156, .src = 151 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2793 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 151, .left = 154, .right = 156, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 151, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 151, .index = 151 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 155, .string_index = 146 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 153, .object = 151, .key = 155 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 155, .callee = 153, .this_value = 151, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 151, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 153, .object = 155, .key = 151 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 151, .callee = 153, .this_value = 155, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 155, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 153, .object = 151, .key = 155 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 153, .index = 152 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 153, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 155, .index = 152 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 151, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 157, .object = 155, .key = 151 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 151, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 155, .left = 157, .right = 151, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 151, .src = 155 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 155, .target_ip = 2814 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2821 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 155, .index = 152 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 157, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 158, .object = 155, .key = 157 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 157, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 155, .left = 158, .right = 157, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 151, .src = 155 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2821 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 151, .target_ip = 2823 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2826 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 155, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 157, .src = 155 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2829 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 155, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 157, .src = 155 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2829 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 155, .left = 153, .right = 157, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 155, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 155, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 158, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 159, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 160, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 158, .key = 159, .value = 160 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 160, .callee = 155, .argument_count = 1, .arguments = (const i32[]) { 158 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 160, .index = 153 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 160, .length = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 160, .index = 154 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 160, .index = 153 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 158, .string_index = 138 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 155, .object = 160, .key = 158 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 158, .function_index = 45 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 159, .callee = 155, .this_value = 160, .argument_count = 1, .arguments = (const i32[]) { 158 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 158, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 160, .index = 154 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 155, .string_index = 140 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 159, .object = 160, .key = 155 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 155, .string_index = 147 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 161, .callee = 159, .this_value = 160, .argument_count = 1, .arguments = (const i32[]) { 155 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 155, .string_index = 148 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 160, .left = 161, .right = 155, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 160, .target_ip = 2855 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2858 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 160, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 155, .src = 160 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2861 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 160, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 155, .src = 160 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2861 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 160, .left = 158, .right = 155, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 160, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 160, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 161, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 159, .value = 0 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 162, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 163, .value = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 164, .string_index = 149 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 162, .key = 163, .value = 164 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 164, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 163, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 162, .key = 164, .value = 163 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 161, .key = 159, .value = 162 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 162, .callee = 160, .argument_count = 1, .arguments = (const i32[]) { 161 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 162, .index = 155 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 162, .index = 155 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 161, .string_index = 146 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 160, .object = 162, .key = 161 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 161, .callee = 160, .this_value = 162, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 161, .index = 156 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 161, .index = 155 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 162, .string_index = 150 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 160, .object = 161, .key = 162 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 164, .callee = 160, .this_value = 161, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 161, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 160, .index = 156 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 162, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 159, .object = 160, .key = 162 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 162, .callee = 159, .this_value = 160, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 160, .string_index = 151 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 159, .object = 162, .key = 160 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 160, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 162, .left = 159, .right = 160, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 162, .target_ip = 2896 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2899 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 162, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 160, .src = 162 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2902 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 162, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 160, .src = 162 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2902 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 162, .left = 161, .right = 160, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 162, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 162, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 159, .index = 155 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 163, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 164, .object = 159, .key = 163 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 163, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 159, .left = 164, .right = 163, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 159, .target_ip = 2912 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2915 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 159, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 163, .src = 159 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2918 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 159, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 163, .src = 159 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2918 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 159, .left = 162, .right = 163, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 159, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 159, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 164, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 165 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 166, .callee = 164, .argument_count = 1, .arguments = (const i32[]) { 165 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 165, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 164, .object = 166, .key = 165 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 165, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 166, .left = 164, .right = 165, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 166, .target_ip = 2930 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2933 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 166, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 165, .src = 166 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2936 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 166, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 165, .src = 166 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2936 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 166, .left = 159, .right = 165, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 166, .index = 147 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 166, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 164, .value = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 167, .string_index = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 166, .key = 164, .value = 167 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 167, .value = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 164, .string_index = 101 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 166, .key = 167, .value = 164 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 164, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 167, .string_index = 143 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 168, .object = 164, .key = 167 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 167, .object = 166, .key = 168 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 168, .callee = 167, .this_value = 166, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 168, .index = 157 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 168, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 166, .index = 157 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 167, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 164, .object = 166, .key = 167 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 167, .callee = 164, .this_value = 166, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 166, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 164, .object = 167, .key = 166 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 166, .string_index = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 167, .left = 164, .right = 166, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 167, .target_ip = 2962 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2965 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 167, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 166, .src = 167 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2968 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 167, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 166, .src = 167 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2968 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 167, .left = 168, .right = 166, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 167, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 167, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 164, .index = 157 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 169, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 170, .object = 164, .key = 169 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 169, .callee = 170, .this_value = 164, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 164, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 170, .object = 169, .key = 164 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 164, .string_index = 101 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 169, .left = 170, .right = 164, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 169, .target_ip = 2981 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2984 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 169, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 164, .src = 169 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2987 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 169, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 164, .src = 169 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 2987 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 169, .left = 167, .right = 164, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 169, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 169, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 170, .index = 157 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 171, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 172, .object = 170, .key = 171 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 171, .callee = 172, .this_value = 170, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 170, .string_index = 151 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 172, .object = 171, .key = 170 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 170, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 171, .left = 172, .right = 170, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 171, .target_ip = 3000 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3003 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 171, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 170, .src = 171 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3006 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 171, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 170, .src = 171 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3006 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 171, .left = 169, .right = 170, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 171, .index = 147 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 171, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 172, .value = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 173, .string_index = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 171, .key = 172, .value = 173 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 173, .string_index = 146 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 172, .object = 171, .key = 173 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 173, .callee = 172, .this_value = 171, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 171, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 172, .object = 173, .key = 171 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 171, .callee = 172, .this_value = 173, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 173, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 172, .object = 171, .key = 173 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 172, .index = 158 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 172, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 173, .index = 158 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 171, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 174, .object = 173, .key = 171 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 171, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 173, .left = 174, .right = 171, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 171, .src = 173 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 173, .target_ip = 3030 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3037 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 173, .index = 158 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 174, .value = 1 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 175, .object = 173, .key = 174 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 174, .string_index = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 173, .left = 175, .right = 174, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 171, .src = 173 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3037 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 171, .target_ip = 3039 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3042 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 173, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 174, .src = 173 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3045 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 173, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 174, .src = 173 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3045 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 173, .left = 172, .right = 174, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 173, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 173, .index = 147 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 175, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 176, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 177, .value = 7 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 175, .key = 176, .value = 177 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 177, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 176, .value = 8 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 175, .key = 177, .value = 176 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 176, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 177, .object = 175, .key = 176 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 176, .callee = 177, .this_value = 175, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 175, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 177, .object = 176, .key = 175 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 175, .callee = 177, .this_value = 176, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 176, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 177, .object = 175, .key = 176 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 176, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 175, .left = 177, .right = 176, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 175, .target_ip = 3067 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3070 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 175, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 176, .src = 175 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3073 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 175, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 176, .src = 175 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3073 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 175, .left = 173, .right = 176, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 175, .index = 147 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 175, .string_index = 152 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 177, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 178, .string_index = 143 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 179, .object = 177, .key = 178 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 178, .object = 175, .key = 179 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 179, .callee = 178, .this_value = 175, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 179, .index = 159 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 179, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 175, .index = 159 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 178, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 177, .object = 175, .key = 178 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 178, .callee = 177, .this_value = 175, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 175, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 177, .object = 178, .key = 175 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 175, .string_index = 90 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 178, .left = 177, .right = 175, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 178, .target_ip = 3093 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3096 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 178, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 175, .src = 178 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3099 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 178, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 175, .src = 178 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3099 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 178, .left = 179, .right = 175, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 178, .index = 147 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 178, .string_index = 153 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 177, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 180, .string_index = 143 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 181, .object = 177, .key = 180 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 180, .object = 178, .key = 181 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 181, .callee = 180, .this_value = 178, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 181, .index = 160 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 181, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 178, .index = 160 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 180, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 177, .object = 178, .key = 180 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 180, .callee = 177, .this_value = 178, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 178, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 177, .object = 180, .key = 178 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 178, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 180, .object = 177, .key = 178 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 178, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 177, .left = 180, .right = 178, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 177, .target_ip = 3121 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3124 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 177, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 178, .src = 177 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3127 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 177, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 178, .src = 177 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3127 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 177, .left = 181, .right = 178, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 177, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 177, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 180, .index = 160 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 182, .string_index = 142 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 183, .object = 180, .key = 182 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 182, .callee = 183, .this_value = 180, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 180, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 183, .object = 182, .key = 180 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 180, .string_index = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 182, .left = 183, .right = 180, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 182, .target_ip = 3140 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3143 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 182, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 180, .src = 182 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3146 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 182, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 180, .src = 182 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3146 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 182, .left = 177, .right = 180, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 182, .index = 147 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 182 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 182, .index = 161 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 182, .index = 161 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 183, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 184, .string_index = 143 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 185, .object = 183, .key = 184 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 184, .function_index = 46 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 182, .key = 185, .value = 184 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 184, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 185, .index = 161 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 182, .callee = 184, .argument_count = 1, .arguments = (const i32[]) { 185 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 182, .index = 162 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 182, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 185, .index = 162 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 184, .string_index = 136 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 183, .object = 185, .key = 184 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 184, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 186, .callee = 183, .this_value = 185, .argument_count = 1, .arguments = (const i32[]) { 184 } } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 184, .src = 186 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 186, .target_ip = 3169 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3176 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 186, .index = 162 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 185, .string_index = 136 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 183, .object = 186, .key = 185 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 185, .value = 20 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 187, .callee = 183, .this_value = 186, .argument_count = 1, .arguments = (const i32[]) { 185 } } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 184, .src = 187 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3176 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 187, .src = 184 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 184, .target_ip = 3179 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3186 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 185, .index = 162 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 186, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 183, .object = 185, .key = 186 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 186, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 185, .left = 183, .right = 186, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 187, .src = 185 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3186 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 187, .target_ip = 3188 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3191 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 185, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 186, .src = 185 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3194 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 185, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 186, .src = 185 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3194 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 185, .left = 182, .right = 186, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 185, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 185, .intrinsic = MAL_INTRINSIC_WEAK_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 183, .callee = 185, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 183, .index = 163 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 183 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 183, .index = 164 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 183, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 185, .index = 163 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 188, .string_index = 131 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 189, .object = 185, .key = 188 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 188, .index = 164 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 190, .value = 42 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 191, .callee = 189, .this_value = 185, .argument_count = 2, .arguments = (const i32[]) { 188, 190 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 190, .index = 163 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 188, .left = 191, .right = 190, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 188, .target_ip = 3212 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3215 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 188, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 190, .src = 188 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3218 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 188, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 190, .src = 188 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3218 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 188, .left = 183, .right = 190, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 188, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 188, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 191, .index = 163 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 185, .string_index = 51 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 189, .object = 191, .key = 185 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 185, .index = 164 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 192, .callee = 189, .this_value = 191, .argument_count = 1, .arguments = (const i32[]) { 185 } } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 185, .value = 42 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 191, .left = 192, .right = 185, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 191, .target_ip = 3230 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3233 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 191, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 185, .src = 191 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3236 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 191, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 185, .src = 191 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3236 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 191, .left = 188, .right = 185, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 191, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 191, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 192, .index = 163 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 189, .string_index = 136 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 193, .object = 192, .key = 189 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 189, .index = 164 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 194, .callee = 193, .this_value = 192, .argument_count = 1, .arguments = (const i32[]) { 189 } } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 189, .src = 194 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 194, .target_ip = 3247 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3255 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 194, .index = 163 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 192, .string_index = 136 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 193, .object = 194, .key = 192 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 192 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 195, .callee = 193, .this_value = 194, .argument_count = 1, .arguments = (const i32[]) { 192 } } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 192, .src = 195, .op = MAL_UNARY_NOT } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 189, .src = 192 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3255 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 189, .target_ip = 3257 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3260 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 192, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 195, .src = 192 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3263 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 192, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 195, .src = 192 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3263 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 192, .left = 191, .right = 195, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 192, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 192, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 194, .index = 163 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 193, .string_index = 135 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 196, .object = 194, .key = 193 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 193, .index = 164 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 197, .callee = 196, .this_value = 194, .argument_count = 1, .arguments = (const i32[]) { 193 } } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 193, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 194, .left = 197, .right = 193, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 194, .target_ip = 3275 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3278 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 194, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 193, .src = 194 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3281 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 194, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 193, .src = 194 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3281 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 194, .left = 192, .right = 193, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 194, .index = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 194, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 194, .index = 165 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 194, .index = 163 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 197, .string_index = 131 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 196, .object = 194, .key = 197 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 197, .value = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 198, .string_index = 154 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 199, .callee = 196, .this_value = 194, .argument_count = 2, .arguments = (const i32[]) { 197, 198 } } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3293 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3310 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 198 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 197, .src = 198 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 198, .src = 197 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 197, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 194, .left = 198, .right = 197, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 194, .target_ip = 3302 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3305 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 194, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 197, .src = 194 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3308 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 194, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 197, .src = 194 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3308 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 197, .index = 165 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3310 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 194, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 198, .index = 165 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 196, .left = 194, .right = 198, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 196, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 196, .intrinsic = MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 198, .callee = 196, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 198, .index = 166 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 198 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 198, .index = 167 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 198, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 196, .index = 166 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 194, .string_index = 144 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 199, .object = 196, .key = 194 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 194, .index = 167 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 200, .callee = 199, .this_value = 196, .argument_count = 1, .arguments = (const i32[]) { 194 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 194, .index = 166 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 196, .left = 200, .right = 194, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 194, .src = 196 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 196, .target_ip = 3330 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3337 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 196, .index = 166 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 200, .string_index = 136 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 199, .object = 196, .key = 200 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 200, .index = 167 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 201, .callee = 199, .this_value = 196, .argument_count = 1, .arguments = (const i32[]) { 200 } } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 194, .src = 201 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3337 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 194, .target_ip = 3339 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3342 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 201, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 200, .src = 201 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3345 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 201, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 200, .src = 201 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3345 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 201, .left = 198, .right = 200, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 201, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 201, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 196, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 199 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 202, .callee = 196, .this_value = 199, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 199, .src = 202, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 202, .string_index = 155 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 196, .left = 199, .right = 202, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 196, .target_ip = 3356 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3359 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 196, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 202, .src = 196 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3362 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 196, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 202, .src = 196 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3362 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 196, .left = 201, .right = 202, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 196, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 196, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 199, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 203 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 204, .string_index = 2 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 205, .callee = 199, .this_value = 203, .argument_count = 1, .arguments = (const i32[]) { 204 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 204, .string_index = 156 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 203, .object = 205, .key = 204 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 204, .string_index = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 205, .left = 203, .right = 204, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 205, .target_ip = 3375 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3378 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 205, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 204, .src = 205 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3381 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 205, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 204, .src = 205 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3381 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 205, .left = 196, .right = 204, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 205, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 205, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 203, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 199 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 206, .callee = 203, .this_value = 199, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 199, .string_index = 156 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 203, .object = 206, .key = 199 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 199 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 206, .left = 203, .right = 199, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 206, .target_ip = 3393 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3396 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 206, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 199, .src = 206 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3399 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 206, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 199, .src = 206 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3399 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 206, .left = 205, .right = 199, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 206, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 206, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 203, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 207, .string_index = 143 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 208, .object = 203, .key = 207 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 207, .string_index = 39 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 203, .object = 208, .key = 207 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 207, .callee = 203, .this_value = 208, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 208, .string_index = 157 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 203, .left = 207, .right = 208, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 203, .target_ip = 3412 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3415 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 203, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 208, .src = 203 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3418 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 203, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 208, .src = 203 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3418 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 203, .left = 206, .right = 208, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 203, .index = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 203, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 203, .index = 168 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 203, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 207 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 209, .callee = 203, .this_value = 207, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3427 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3444 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 207 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 203, .src = 207 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 207, .src = 203 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 203, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 209, .left = 207, .right = 203, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 209, .target_ip = 3436 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3439 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 209, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 203, .src = 209 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3442 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 209, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 203, .src = 209 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3442 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 203, .index = 168 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3444 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 209, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 207, .index = 168 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 210, .left = 209, .right = 207, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 210, .index = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 210, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 210, .index = 169 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 210, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 207 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 209, .callee = 210, .this_value = 207, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3455 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3472 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 207 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 210, .src = 207 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 207, .src = 210 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 210, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 209, .left = 207, .right = 210, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 209, .target_ip = 3464 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3467 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 209, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 210, .src = 209 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3470 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 209, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 210, .src = 209 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3470 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 210, .index = 169 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3472 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 209, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 207, .index = 169 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 211, .left = 209, .right = 207, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 211, .index = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 211, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 211, .index = 170 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 211, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 209, .callee = 211, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3482 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3499 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 211 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 207, .src = 211 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 211, .src = 207 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 207, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 209, .left = 211, .right = 207, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 209, .target_ip = 3491 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3494 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 209, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 207, .src = 209 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3497 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 209, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 207, .src = 209 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3497 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 207, .index = 170 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3499 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 209, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 211, .index = 170 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 212, .left = 209, .right = 211, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 212, .index = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 212, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 212, .index = 171 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 212, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 211, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 209, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 213, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 211, .key = 209, .value = 213 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 209, .callee = 212, .argument_count = 1, .arguments = (const i32[]) { 211 } } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3513 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3530 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 211 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 212, .src = 211 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 211, .src = 212 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 212, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 213, .left = 211, .right = 212, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 213, .target_ip = 3522 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3525 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 213, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 212, .src = 213 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3528 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 213, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 212, .src = 213 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3528 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 212, .index = 171 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3530 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 213, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 211, .index = 171 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 209, .left = 213, .right = 211, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 209, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 209, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 211, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 213, .object = 209, .key = 211 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 211, .string_index = 39 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 209, .object = 213, .key = 211 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 209, .index = 172 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 209, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 211, .index = 172 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 213, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 214, .object = 211, .key = 213 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 213, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 215, .callee = 213, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 213, .callee = 214, .this_value = 211, .argument_count = 1, .arguments = (const i32[]) { 215 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 215, .string_index = 158 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 211, .left = 213, .right = 215, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 211, .target_ip = 3551 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3554 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 211, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 215, .src = 211 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3557 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 211, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 215, .src = 211 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3557 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 211, .left = 209, .right = 215, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 211, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 211, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 213, .index = 172 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 214, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 216, .object = 213, .key = 214 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 214, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 217, .callee = 214, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 214, .callee = 216, .this_value = 213, .argument_count = 1, .arguments = (const i32[]) { 217 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 217, .string_index = 159 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 213, .left = 214, .right = 217, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 213, .target_ip = 3570 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3573 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 213, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 217, .src = 213 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3576 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 213, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 217, .src = 213 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3576 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 213, .left = 211, .right = 217, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 213, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 213, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 214, .index = 172 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 216, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 218, .object = 214, .key = 216 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 216, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 219 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 220, .callee = 216, .this_value = 219, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 219, .callee = 218, .this_value = 214, .argument_count = 1, .arguments = (const i32[]) { 220 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 220, .string_index = 160 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 214, .left = 219, .right = 220, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 214, .target_ip = 3590 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3593 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 214, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 220, .src = 214 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3596 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 214, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 220, .src = 214 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3596 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 214, .left = 213, .right = 220, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 214, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 214, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 219, .index = 172 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 218, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 216, .object = 219, .key = 218 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 218, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 221, .callee = 216, .this_value = 219, .argument_count = 1, .arguments = (const i32[]) { 218 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 218, .string_index = 161 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 219, .left = 221, .right = 218, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 219, .target_ip = 3608 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3611 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 219, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 218, .src = 219 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3614 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 219, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 218, .src = 219 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3614 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 219, .left = 214, .right = 218, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 219, .index = 147 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 219 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 219, .index = 173 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 219, .index = 173 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 221, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 216, .string_index = 162 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 222, .object = 221, .key = 216 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 216, .string_index = 163 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 219, .key = 222, .value = 216 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 216, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 222, .index = 172 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 219, .string_index = 19 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 221, .object = 222, .key = 219 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 219, .index = 173 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 223, .callee = 221, .this_value = 222, .argument_count = 1, .arguments = (const i32[]) { 219 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 219, .string_index = 164 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 222, .left = 223, .right = 219, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 222, .target_ip = 3634 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3637 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 222, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 219, .src = 222 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3640 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 222, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 219, .src = 222 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3640 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 222, .left = 216, .right = 219, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 222, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 222, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 223, .intrinsic = MAL_INTRINSIC_FUNCTION_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 221, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 224, .object = 223, .key = 221 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 221, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 223, .string_index = 165 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 225, .object = 221, .key = 223 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 223, .object = 224, .key = 225 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 225, .src = 223, .op = MAL_UNARY_TYPEOF } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 223, .string_index = 44 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 224, .left = 225, .right = 223, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 224, .target_ip = 3655 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3658 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 224, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 223, .src = 224 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3661 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 224, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 223, .src = 224 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3661 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 224, .left = 222, .right = 223, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 224, .index = 147 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 224 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 224, .index = 174 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 224, .index = 174 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 225, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 221, .string_index = 165 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 226, .object = 225, .key = 221 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 221, .function_index = 48 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 224, .key = 226, .value = 221 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 221, .index = 147 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 226, .value = 42 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 224, .index = 174 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 225, .left = 226, .right = 224, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 225, .target_ip = 3677 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3680 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 225, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 224, .src = 225 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3683 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 225, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 224, .src = 225 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3683 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 225, .left = 221, .right = 224, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 225, .index = 147 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 225, .function_index = 49 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 225, .index = 175 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 225, .index = 175 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 226, .string_index = 21 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 227, .object = 225, .key = 226 } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 226 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 228, .callee = 227, .this_value = 225, .argument_count = 1, .arguments = (const i32[]) { 226 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 228, .index = 176 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 228, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 226, .index = 175 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 225, .callee = 226, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 226, .index = 176 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 227, .left = 225, .right = 226, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 227, .target_ip = 3700 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3703 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 227, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 226, .src = 227 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3706 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 227, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 226, .src = 227 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3706 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 227, .left = 228, .right = 226, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 227, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 227, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 225, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 229, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 230, .string_index = 167 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 231, .object = 229, .key = 230 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 230, .object = 225, .key = 231 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 231, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 225, .left = 230, .right = 231, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 225, .target_ip = 3718 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3721 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 225, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 231, .src = 225 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3724 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 225, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 231, .src = 225 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3724 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 225, .left = 227, .right = 231, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 225, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 225, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 230, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 229, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 232, .string_index = 167 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 233, .object = 229, .key = 232 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 232, .object = 230, .key = 233 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 233, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 230, .left = 232, .right = 233, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 230, .target_ip = 3736 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3739 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 230, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 233, .src = 230 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3742 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 230, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 233, .src = 230 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3742 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 230, .left = 225, .right = 233, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 230, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 230, .index = 147 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 232, .intrinsic = MAL_INTRINSIC_ARRAY_CONSTRUCTOR } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 229, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 234, .string_index = 167 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 235, .object = 229, .key = 234 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 234, .object = 232, .key = 235 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 235, .intrinsic = MAL_INTRINSIC_ARRAY_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 232, .left = 234, .right = 235, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 232, .target_ip = 3754 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3757 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 232, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 235, .src = 232 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3760 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 232, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 235, .src = 232 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3760 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 232, .left = 230, .right = 235, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 232, .index = 147 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 232 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 234, .string_index = 22 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 229, .value = 2 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 232, .key = 234, .value = 229, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 229, .value = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 234, .string_index = 90 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 232, .key = 229, .value = 234, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 234, .value = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 229, .string_index = 91 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 232, .key = 234, .value = 229, .enumerable = true } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 232, .index = 177 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 232, .index = 177 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 229, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 234, .string_index = 168 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 236, .object = 229, .key = 234 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 234, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 232, .key = 236, .value = 234 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 234, .index = 147 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 236, .length = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 232, .string_index = 169 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 229, .object = 236, .key = 232 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 232, .index = 177 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 237, .callee = 229, .this_value = 236, .argument_count = 1, .arguments = (const i32[]) { 232 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 232, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 236, .object = 237, .key = 232 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 232, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 237, .left = 236, .right = 232, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 237, .target_ip = 3791 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3794 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 237, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 232, .src = 237 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3797 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 237, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 232, .src = 237 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3797 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 237, .left = 234, .right = 232, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 237, .index = 147 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 237, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 236, .index = 147 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 229, .left = 237, .right = 236, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 229, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 229, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 229, .index = 178 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 229, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 229, .index = 179 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 229, .length = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 236, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 237, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 229, .key = 236, .value = 237 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 237, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 236, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 229, .key = 237, .value = 236 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 236, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 237, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 229, .key = 236, .value = 237 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 237, .next_dst = 236, .source = 229 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3819 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 229, .done_dst = 238, .iterator = 237, .next = 236 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 238, .target_ip = 3833 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 238, .src = 229 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 229, .index = 179 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 239, .src = 238 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 238, .left = 229, .right = 239, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 238, .index = 179 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3828 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3819 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 238 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 237 } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 238 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 238, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 239, .index = 179 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 229, .value = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 240, .left = 239, .right = 229, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 240, .target_ip = 3839 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3842 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 240, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 229, .src = 240 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3845 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 240, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 229, .src = 240 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3845 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 240, .left = 238, .right = 229, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 240, .index = 178 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 240, .string_index = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 240, .index = 180 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 240, .string_index = 170 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 239, .next_dst = 241, .source = 240 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3852 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 240, .done_dst = 242, .iterator = 239, .next = 241 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 242, .target_ip = 3866 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 242, .src = 240 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 240, .index = 180 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 243, .src = 242 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 242, .left = 240, .right = 243, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 242, .index = 180 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3861 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3852 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 242 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 239 } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 242 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 242, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 243, .index = 180 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 240, .string_index = 170 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 244, .left = 243, .right = 240, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 244, .target_ip = 3872 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3875 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 244, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 240, .src = 244 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3878 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 244, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 240, .src = 244 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3878 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 244, .left = 242, .right = 240, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 244, .index = 178 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 244, .string_index = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 244, .index = 181 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 244, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 243, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 245, .value = 0 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 246, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 247, .value = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 248, .string_index = 90 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 246, .key = 247, .value = 248 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 248, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 247, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 246, .key = 248, .value = 247 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 243, .key = 245, .value = 246 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 246, .value = 1 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 245, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 247, .value = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 248, .string_index = 91 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 245, .key = 247, .value = 248 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 248, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 247, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 245, .key = 248, .value = 247 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 243, .key = 246, .value = 245 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 245, .callee = 244, .argument_count = 1, .arguments = (const i32[]) { 243 } } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 243, .next_dst = 244, .source = 245 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3905 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 245, .done_dst = 246, .iterator = 243, .next = 244 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 246, .target_ip = 3928 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 246, .next_dst = 247, .source = 245 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 245, .done_dst = 248, .iterator = 246, .next = 247 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 248, .src = 245 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 245, .done_dst = 249, .iterator = 246, .next = 247 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 247, .src = 245 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 249, .target_ip = 3916 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 246 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3916 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 246, .index = 181 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 249, .src = 248 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 245, .src = 247 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 250, .left = 249, .right = 245, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 245, .left = 246, .right = 250, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 245, .index = 181 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3923 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3905 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 245 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 243 } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 245 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 245, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 250, .index = 181 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 246, .string_index = 171 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 249, .left = 250, .right = 246, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 249, .target_ip = 3934 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3937 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 249, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 246, .src = 249 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3940 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 249, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 246, .src = 249 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3940 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 249, .left = 245, .right = 246, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 249, .index = 178 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 249, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 249, .index = 182 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 249, .function_index = 50 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 249, .index = 183 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 249, .index = 183 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 250 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 251, .callee = 249, .this_value = 250, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 250, .next_dst = 249, .source = 251 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3951 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 251, .done_dst = 252, .iterator = 250, .next = 249 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 252, .target_ip = 3967 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 252, .src = 251 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 251, .src = 252 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 252, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 253, .left = 251, .right = 252, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 253, .target_ip = 3960 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3962 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 250 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3967 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3951 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 253 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 250 } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 253 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 253, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 252, .index = 182 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 251, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 254, .left = 252, .right = 251, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 254, .target_ip = 3973 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3976 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 254, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 251, .src = 254 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3979 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 254, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 251, .src = 254 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3979 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 254, .left = 253, .right = 251, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 254, .index = 178 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 254, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 254, .index = 184 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 254, .index = 183 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 252 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 255, .callee = 254, .this_value = 252, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 252, .next_dst = 254, .source = 255 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3988 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 255, .done_dst = 256, .iterator = 252, .next = 254 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 256, .target_ip = 4008 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 256, .src = 255 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 255, .src = 256 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 257, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 258, .left = 255, .right = 257, .op = MAL_BIN_REM } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 257, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 255, .left = 258, .right = 257, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 255, .target_ip = 3988 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 255, .index = 184 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 257, .src = 256 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 256, .left = 255, .right = 257, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 256, .index = 184 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4003 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 3988 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 256 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 252 } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 256 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 256, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 257, .index = 182 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 255, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 258, .left = 257, .right = 255, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 255, .src = 258 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 258, .target_ip = 4015 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4020 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 258, .index = 184 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 257, .value = 9 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 259, .left = 258, .right = 257, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 255, .src = 259 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4020 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 255, .target_ip = 4022 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4025 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 259, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 257, .src = 259 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4028 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 259, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 257, .src = 259 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4028 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 259, .left = 256, .right = 257, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 259, .index = 178 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 259, .function_index = 54 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 258 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 260, .callee = 259, .this_value = 258, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 258, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 259, .index = 182 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 260, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 261, .left = 259, .right = 260, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 261, .target_ip = 4039 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4042 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 261, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 260, .src = 261 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4045 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 261, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 260, .src = 261 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4045 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 261, .left = 258, .right = 260, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 261, .index = 178 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 261, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 261, .index = 185 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 261, .index = 183 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 259 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 262, .callee = 261, .this_value = 259, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 259, .next_dst = 261, .source = 262 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4055 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 262, .done_dst = 263, .iterator = 259, .next = 261 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 263, .target_ip = 4068 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 263, .src = 262 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 262, .intrinsic = MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 263, .string_index = 174 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 264, .callee = 262, .argument_count = 1, .arguments = (const i32[]) { 263 } } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 264 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4055 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 264 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 259 } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 264 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4085 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 264 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 263, .src = 264 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 264, .src = 263 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 263, .intrinsic = MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 262, .left = 264, .right = 263, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 262, .target_ip = 4077 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4080 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 262, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 263, .src = 262 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4083 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 262, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 263, .src = 262 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4083 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 263, .index = 185 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4085 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 262, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 264, .index = 185 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 265, .left = 262, .right = 264, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 265, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 265, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 264, .index = 182 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 262, .value = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 266, .left = 264, .right = 262, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 266, .target_ip = 4095 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4098 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 266, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 262, .src = 266 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4101 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 266, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 262, .src = 266 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4101 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 266, .left = 265, .right = 262, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 266, .index = 178 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 266, .length = 5 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 264, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 267, .value = 10 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 266, .key = 264, .value = 267 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 267, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 264, .value = 20 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 266, .key = 267, .value = 264 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 264, .value = 2 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 267 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 266, .key = 264, .value = 267 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 267, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 264, .value = 40 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 266, .key = 267, .value = 264 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 264, .value = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 267, .value = 50 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 266, .key = 264, .value = 267 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 267, .next_dst = 264, .source = 266 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 266, .done_dst = 268, .iterator = 267, .next = 264 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 266, .index = 186 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 268, .done_dst = 268, .iterator = 267, .next = 264 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 266, .done_dst = 268, .iterator = 267, .next = 264 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 268, .src = 266 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 269 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 270, .left = 266, .right = 269, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 270, .target_ip = 4129 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4132 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 270, .value = 30 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 268, .src = 270 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4132 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 268, .index = 187 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 270, .length = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 269, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 266, .value = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4137 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 271, .done_dst = 272, .iterator = 267, .next = 264 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 272, .target_ip = 4142 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 270, .key = 269, .value = 271 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 269, .left = 269, .right = 266, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4137 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 270, .index = 188 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 271, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 272, .index = 186 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 273, .value = 10 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 274, .left = 272, .right = 273, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 273, .src = 274 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 274, .target_ip = 4150 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4155 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 274, .index = 187 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 272, .value = 30 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 275, .left = 274, .right = 272, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 273, .src = 275 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4155 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 275, .src = 273 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 273, .target_ip = 4158 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4167 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 272, .index = 188 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 274, .string_index = 140 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 276, .object = 272, .key = 274 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 274, .string_index = 147 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 277, .callee = 276, .this_value = 272, .argument_count = 1, .arguments = (const i32[]) { 274 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 274, .string_index = 175 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 272, .left = 277, .right = 274, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 275, .src = 272 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4167 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 275, .target_ip = 4169 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4172 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 272, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 274, .src = 272 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4175 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 272, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 274, .src = 272 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4175 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 272, .left = 271, .right = 274, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 272, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 272, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 277, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 276, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 278, .value = 7 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 277, .key = 276, .value = 278 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 278, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 276, .value = 8 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 277, .key = 278, .value = 276 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 276, .callee = 272, .argument_count = 1, .arguments = (const i32[]) { 277 } } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 277, .next_dst = 272, .source = 276 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 276, .done_dst = 278, .iterator = 277, .next = 272 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 276, .index = 189 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 276, .done_dst = 278, .iterator = 277, .next = 272 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 276, .index = 190 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 278, .target_ip = 4194 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 277 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4194 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 277, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 278, .index = 189 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 276, .value = 7 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 272, .left = 278, .right = 276, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 276, .src = 272 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 272, .target_ip = 4201 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4206 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 272, .index = 190 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 278, .value = 8 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 279, .left = 272, .right = 278, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 276, .src = 279 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4206 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 276, .target_ip = 4208 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4211 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 279, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 278, .src = 279 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4214 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 279, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 278, .src = 279 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4214 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 279, .left = 277, .right = 278, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 279, .index = 178 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 279, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 279, .index = 191 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 279 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 279, .index = 192 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 279, .index = 192 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 272, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 280, .string_index = 143 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 281, .object = 272, .key = 280 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 280, .function_index = 55 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 279, .key = 281, .value = 280 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 280, .index = 192 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 281, .next_dst = 279, .source = 280 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 280, .done_dst = 272, .iterator = 281, .next = 279 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 280, .index = 193 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 272, .target_ip = 4233 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 281 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4233 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 281, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 272, .index = 193 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 280, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 279, .left = 272, .right = 280, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 280, .src = 279 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 279, .target_ip = 4240 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4245 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 279, .index = 191 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 272, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 282, .left = 279, .right = 272, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 280, .src = 282 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4245 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 280, .target_ip = 4247 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4250 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 282, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 272, .src = 282 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4253 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 282, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 272, .src = 282 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4253 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 282, .left = 281, .right = 272, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 282, .index = 178 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 282, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 282, .index = 194 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 282, .value = 123 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 279, .next_dst = 283, .source = 282 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 282, .done_dst = 284, .iterator = 279, .next = 283 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 283, .src = 282 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 284, .target_ip = 4265 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 279 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4265 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4282 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 279 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 284, .src = 279 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 279, .src = 284 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 284, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 282, .left = 279, .right = 284, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 282, .target_ip = 4274 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4277 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 282, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 284, .src = 282 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4280 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 282, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 284, .src = 282 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4280 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 284, .index = 194 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4282 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 282, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 279, .index = 194 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 283, .left = 282, .right = 279, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 283, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 283, .index = 178 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 279, .length = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 282, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 285, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 286, .value = 0 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 279, .key = 282, .value = 286 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 282, .left = 282, .right = 285, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 286, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 287, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 288, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 286, .key = 287, .value = 288 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 288, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 287, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 286, .key = 288, .value = 287 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 287, .next_dst = 288, .source = 286 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4302 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 286, .done_dst = 289, .iterator = 287, .next = 288 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 289, .target_ip = 4307 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 279, .key = 282, .value = 286 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 282, .left = 282, .right = 285, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4302 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 286, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 289, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 290, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 291, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 289, .key = 290, .value = 291 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 291, .callee = 286, .argument_count = 1, .arguments = (const i32[]) { 289 } } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 289, .next_dst = 286, .source = 291 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4315 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 291, .done_dst = 290, .iterator = 289, .next = 286 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 290, .target_ip = 4320 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 279, .key = 282, .value = 291 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 282, .left = 282, .right = 285, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4315 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 291, .string_index = 22 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 279, .key = 291, .value = 282 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 291, .string_index = 140 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 290, .object = 279, .key = 291 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 291, .string_index = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 292, .callee = 290, .this_value = 279, .argument_count = 1, .arguments = (const i32[]) { 291 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 291, .string_index = 176 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 290, .left = 292, .right = 291, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 290, .target_ip = 4330 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4333 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 290, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 291, .src = 290 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4336 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 290, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 291, .src = 290 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4336 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 290, .left = 283, .right = 291, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 290, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 290, .index = 178 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 292, .length = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 293, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 294, .value = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 295, .string_index = 152 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 296, .next_dst = 297, .source = 295 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4345 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 295, .done_dst = 298, .iterator = 296, .next = 297 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 298, .target_ip = 4350 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 292, .key = 293, .value = 295 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 293, .left = 293, .right = 294, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4345 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 295, .string_index = 22 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 292, .key = 295, .value = 293 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 295, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 298, .object = 292, .key = 295 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 295, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 299, .left = 298, .right = 295, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 299, .target_ip = 4358 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4361 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 299, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 295, .src = 299 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4364 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 299, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 295, .src = 299 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4364 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 299, .left = 290, .right = 295, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 299, .index = 178 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 299, .function_index = 58 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 299, .index = 195 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 299, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 298, .index = 195 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 300 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 301, .length = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 302, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 303, .value = 1 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 304, .length = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 305, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 306, .value = 4 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 304, .key = 305, .value = 306 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 306, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 305, .value = 5 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 304, .key = 306, .value = 305 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 305, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 306, .value = 6 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 304, .key = 305, .value = 306 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 306, .next_dst = 305, .source = 304 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4386 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 304, .done_dst = 307, .iterator = 306, .next = 305 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 307, .target_ip = 4391 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 301, .key = 302, .value = 304 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 302, .left = 302, .right = 303, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4386 } },
    { .opcode = MAL_OP_CALL_SPREAD, .as.call_spread = { .dst = 304, .callee = 298, .this_value = 300, .arguments_array = 301 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 307, .value = 15 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 308, .left = 304, .right = 307, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 308, .target_ip = 4396 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4399 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 308, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 307, .src = 308 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4402 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 308, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 307, .src = 308 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4402 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 308, .left = 299, .right = 307, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 308, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 308, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 304, .index = 195 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 309 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 310, .length = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 311, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 312, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 313, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 310, .key = 311, .value = 313 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 311, .left = 311, .right = 312, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 313, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 314, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 315, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 313, .key = 314, .value = 315 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 315, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 314, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 313, .key = 315, .value = 314 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 314, .next_dst = 315, .source = 313 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4422 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 313, .done_dst = 316, .iterator = 314, .next = 315 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 316, .target_ip = 4427 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 310, .key = 311, .value = 313 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 311, .left = 311, .right = 312, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4422 } },
    { .opcode = MAL_OP_CALL_SPREAD, .as.call_spread = { .dst = 313, .callee = 304, .this_value = 309, .arguments_array = 310 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 316, .value = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 317, .left = 313, .right = 316, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 317, .target_ip = 4432 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4435 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 317, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 316, .src = 317 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4438 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 317, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 316, .src = 317 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4438 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 317, .left = 308, .right = 316, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 317, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 317, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 313, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 318, .string_index = 83 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 319, .object = 313, .key = 318 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 318, .length = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 320, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 321, .value = 1 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 322, .length = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 323, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 324, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 322, .key = 323, .value = 324 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 324, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 323, .value = 9 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 322, .key = 324, .value = 323 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 323, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 324, .value = 4 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 322, .key = 323, .value = 324 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 324, .next_dst = 323, .source = 322 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4459 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 322, .done_dst = 325, .iterator = 324, .next = 323 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 325, .target_ip = 4464 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 318, .key = 320, .value = 322 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 320, .left = 320, .right = 321, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4459 } },
    { .opcode = MAL_OP_CALL_SPREAD, .as.call_spread = { .dst = 322, .callee = 319, .this_value = 313, .arguments_array = 318 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 325, .value = 9 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 326, .left = 322, .right = 325, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 326, .target_ip = 4469 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4472 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 326, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 325, .src = 326 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4475 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 326, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 325, .src = 326 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4475 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 326, .left = 317, .right = 325, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 326, .index = 178 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 326, .function_index = 59 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 326, .index = 196 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 326, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 322, .index = 196 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 327, .length = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 328, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 329, .value = 1 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 330, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 331, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 332, .value = 20 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 330, .key = 331, .value = 332 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 332, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 331, .value = 22 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 330, .key = 332, .value = 331 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 331, .next_dst = 332, .source = 330 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4493 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 330, .done_dst = 333, .iterator = 331, .next = 332 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 333, .target_ip = 4498 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 327, .key = 328, .value = 330 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 328, .left = 328, .right = 329, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4493 } },
    { .opcode = MAL_OP_CONSTRUCT_SPREAD, .as.construct_spread = { .dst = 330, .callee = 322, .arguments_array = 327 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 333, .string_index = 179 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 334, .object = 330, .key = 333 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 333, .value = 42 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 330, .left = 334, .right = 333, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 330, .target_ip = 4505 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4508 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 330, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 333, .src = 330 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4511 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 330, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 333, .src = 330 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4511 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 330, .left = 326, .right = 333, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 330, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 330, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 334, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 335, .string_index = 180 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 336, .object = 334, .key = 335 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 335, .string_index = 181 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 337, .callee = 336, .this_value = 334, .argument_count = 1, .arguments = (const i32[]) { 335 } } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 335, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 334, .string_index = 180 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 336, .object = 335, .key = 334 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 334, .string_index = 181 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 338, .callee = 336, .this_value = 335, .argument_count = 1, .arguments = (const i32[]) { 334 } } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 334, .left = 337, .right = 338, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 334, .target_ip = 4527 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4530 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 334, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 338, .src = 334 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4533 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 334, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 338, .src = 334 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4533 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 334, .left = 330, .right = 338, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 334, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 334, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 337, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 335, .string_index = 182 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 336, .object = 337, .key = 335 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 335, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 339, .string_index = 180 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 340, .object = 335, .key = 339 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 339, .string_index = 181 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 341, .callee = 340, .this_value = 335, .argument_count = 1, .arguments = (const i32[]) { 339 } } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 339, .callee = 336, .this_value = 337, .argument_count = 1, .arguments = (const i32[]) { 341 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 341, .string_index = 181 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 337, .left = 339, .right = 341, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 337, .target_ip = 4549 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4552 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 337, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 341, .src = 337 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4555 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 337, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 341, .src = 337 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4555 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 337, .left = 334, .right = 341, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 337, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 337, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 339, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 336, .string_index = 182 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 335, .object = 339, .key = 336 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 336, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 340 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 342, .string_index = 183 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 343, .callee = 336, .this_value = 340, .argument_count = 1, .arguments = (const i32[]) { 342 } } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 342, .callee = 335, .this_value = 339, .argument_count = 1, .arguments = (const i32[]) { 343 } } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 343 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 339, .left = 342, .right = 343, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 339, .target_ip = 4570 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4573 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 339, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 343, .src = 339 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4576 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 339, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 343, .src = 339 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4576 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 339, .left = 337, .right = 343, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 339, .index = 178 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 339, .value = 0 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 339, .index = 197 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 339, .intrinsic = MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 342, .callee = 339, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 339, .string_index = 144 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 335, .object = 342, .key = 339 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 339, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 340, .string_index = 180 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 336, .object = 339, .key = 340 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 340, .string_index = 184 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 344, .callee = 336, .this_value = 339, .argument_count = 1, .arguments = (const i32[]) { 340 } } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 336, .callee = 335, .this_value = 342, .argument_count = 1, .arguments = (const i32[]) { 344 } } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4592 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4609 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 344 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 342, .src = 344 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 344, .src = 342 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 342, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 335, .left = 344, .right = 342, .op = MAL_BIN_INSTANCEOF } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 335, .target_ip = 4601 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4604 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 335, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 342, .src = 335 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4607 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 335, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 342, .src = 335 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4607 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 342, .index = 197 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4609 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 335, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 344, .index = 197 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 340, .left = 335, .right = 344, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 340, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 340, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 344, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 335, .string_index = 185 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 339, .object = 344, .key = 335 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 335, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 336, .value = 4 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 345, .callee = 339, .this_value = 344, .argument_count = 2, .arguments = (const i32[]) { 335, 336 } } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 336, .value = 12 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 335, .left = 345, .right = 336, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 336, .src = 335 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 335, .target_ip = 4625 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4634 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 335, .intrinsic = MAL_INTRINSIC_MATH } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 345, .string_index = 186 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 344, .object = 335, .key = 345 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 345, .value = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 339, .callee = 344, .this_value = 335, .argument_count = 1, .arguments = (const i32[]) { 345 } } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 345, .value = 32 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 335, .left = 339, .right = 345, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 336, .src = 335 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4634 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 336, .target_ip = 4636 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4639 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 335, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 345, .src = 335 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4642 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 335, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 345, .src = 335 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4642 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 335, .left = 340, .right = 345, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 335, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 335, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 339, .intrinsic = MAL_INTRINSIC_STRING_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 344, .string_index = 187 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 346, .object = 339, .key = 344 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 344, .value = 97 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 347, .callee = 346, .this_value = 339, .argument_count = 1, .arguments = (const i32[]) { 344 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 344, .string_index = 90 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 339, .left = 347, .right = 344, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 339, .target_ip = 4654 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4657 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 339, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 344, .src = 339 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4660 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 339, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 344, .src = 339 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4660 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 339, .left = 335, .right = 344, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 339, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 339, .index = 178 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 347, .string_index = 90 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 346, .string_index = 188 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 348, .object = 347, .key = 346 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 346, .value = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 349, .callee = 348, .this_value = 347, .argument_count = 1, .arguments = (const i32[]) { 346 } } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 346, .value = 97 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 347, .left = 349, .right = 346, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 347, .target_ip = 4672 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4675 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 347, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 346, .src = 347 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4678 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 347, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 346, .src = 347 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4678 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 347, .left = 339, .right = 346, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 347, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 347, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 349, .intrinsic = MAL_INTRINSIC_ARRAY_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 348, .string_index = 189 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 350, .object = 349, .key = 348 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 348, .intrinsic = MAL_INTRINSIC_SET_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 351, .length = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 352, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 353, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 351, .key = 352, .value = 353 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 353, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 352, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 351, .key = 353, .value = 352 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 352, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 353, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 351, .key = 352, .value = 353 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 353, .callee = 348, .argument_count = 1, .arguments = (const i32[]) { 351 } } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 351, .callee = 350, .this_value = 349, .argument_count = 1, .arguments = (const i32[]) { 353 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 353, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 349, .object = 351, .key = 353 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 353, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 351, .left = 349, .right = 353, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 351, .target_ip = 4703 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4706 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 351, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 353, .src = 351 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4709 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 351, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 353, .src = 351 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4709 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 351, .left = 347, .right = 353, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 351, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 351, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 349, .intrinsic = MAL_INTRINSIC_ARRAY_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 350, .string_index = 189 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 348, .object = 349, .key = 350 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 350, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 352, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 354, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 350, .key = 352, .value = 354 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 354, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 352, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 350, .key = 354, .value = 352 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 352, .function_index = 60 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 354, .callee = 348, .this_value = 349, .argument_count = 2, .arguments = (const i32[]) { 350, 352 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 352, .string_index = 140 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 350, .object = 354, .key = 352 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 352, .string_index = 147 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 349, .callee = 350, .this_value = 354, .argument_count = 1, .arguments = (const i32[]) { 352 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 352, .string_index = 190 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 354, .left = 349, .right = 352, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 354, .target_ip = 4732 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4735 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 354, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 352, .src = 354 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4738 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 354, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 352, .src = 354 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4738 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 354, .left = 351, .right = 352, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 354, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 354, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 349, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 350, .string_index = 191 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 348, .object = 349, .key = 350 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 350, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 355, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 356, .value = 0 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 357, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 358, .value = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 359, .string_index = 192 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 357, .key = 358, .value = 359 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 359, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 358, .value = 5 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 357, .key = 359, .value = 358 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 355, .key = 356, .value = 357 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 357, .callee = 350, .argument_count = 1, .arguments = (const i32[]) { 355 } } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 355, .callee = 348, .this_value = 349, .argument_count = 1, .arguments = (const i32[]) { 357 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 357, .string_index = 192 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 349, .object = 355, .key = 357 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 357, .value = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 355, .left = 349, .right = 357, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 355, .target_ip = 4763 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4766 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 355, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 357, .src = 355 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4769 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 355, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 357, .src = 355 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4769 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 355, .left = 354, .right = 357, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 355, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 355, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 349, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 348, .string_index = 193 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 350, .object = 349, .key = 348 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 348, .length = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 356, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 358, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 348, .key = 356, .value = 358 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 358, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 356, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 348, .key = 358, .value = 356 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 356, .function_index = 61 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 358, .callee = 350, .this_value = 349, .argument_count = 2, .arguments = (const i32[]) { 348, 356 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 356, .string_index = 194 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 348, .object = 358, .key = 356 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 356, .string_index = 140 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 358, .object = 348, .key = 356 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 356, .string_index = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 349, .callee = 358, .this_value = 348, .argument_count = 1, .arguments = (const i32[]) { 356 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 356, .string_index = 196 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 348, .left = 349, .right = 356, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 348, .target_ip = 4794 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4797 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 348, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 356, .src = 348 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4800 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 348, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 356, .src = 348 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4800 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 348, .left = 355, .right = 356, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 348, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 348, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 349, .intrinsic = MAL_INTRINSIC_MAP_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 358, .string_index = 193 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 350, .object = 349, .key = 358 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 358, .length = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 359, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 360, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 358, .key = 359, .value = 360 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 360, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 359, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 358, .key = 360, .value = 359 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 359, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 360, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 358, .key = 359, .value = 360 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 360, .function_index = 62 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 359, .callee = 350, .this_value = 349, .argument_count = 2, .arguments = (const i32[]) { 358, 360 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 360, .string_index = 51 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 358, .object = 359, .key = 360 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 360, .value = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 349, .callee = 358, .this_value = 359, .argument_count = 1, .arguments = (const i32[]) { 360 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 360, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 359, .object = 349, .key = 360 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 360, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 349, .left = 359, .right = 360, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 349, .target_ip = 4828 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4831 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 349, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 360, .src = 349 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4834 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 349, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 360, .src = 349 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4834 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 349, .left = 348, .right = 360, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 349, .index = 178 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 349 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 359, .string_index = 90 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 358, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 349, .key = 359, .value = 358, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 358, .string_index = 91 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 359, .value = 2 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 349, .key = 358, .value = 359, .enumerable = true } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 349, .index = 198 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 349 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 359, .index = 198 } },
    { .opcode = MAL_OP_MERGE_DATA_PROPERTIES, .as.merge_data_properties = { .target = 349, .src = 359 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 359, .string_index = 91 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 358, .value = 9 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 349, .key = 359, .value = 358, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 358, .string_index = 96 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 359, .value = 3 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 349, .key = 358, .value = 359, .enumerable = true } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 349, .index = 199 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 349, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 359, .index = 199 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 358, .string_index = 90 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 350, .object = 359, .key = 358 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 358, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 359, .left = 350, .right = 358, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 358, .src = 359 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 359, .target_ip = 4863 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4870 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 359, .index = 199 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 350, .string_index = 91 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 361, .object = 359, .key = 350 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 350, .value = 9 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 359, .left = 361, .right = 350, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 358, .src = 359 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4870 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 359, .src = 358 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 358, .target_ip = 4873 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4880 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 350, .index = 199 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 361, .string_index = 96 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 362, .object = 350, .key = 361 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 361, .value = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 350, .left = 362, .right = 361, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 359, .src = 350 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4880 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 359, .target_ip = 4882 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4885 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 350, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 361, .src = 350 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4888 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 350, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 361, .src = 350 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4888 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 350, .left = 349, .right = 361, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 350, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 350, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 362, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 363, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 364, .object = 362, .key = 363 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 363 } },
    { .opcode = MAL_OP_CREATE_NULL, .as.create_null = { .dst = 365 } },
    { .opcode = MAL_OP_MERGE_DATA_PROPERTIES, .as.merge_data_properties = { .target = 363, .src = 365 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 365 } },
    { .opcode = MAL_OP_MERGE_DATA_PROPERTIES, .as.merge_data_properties = { .target = 363, .src = 365 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 365, .callee = 364, .this_value = 362, .argument_count = 1, .arguments = (const i32[]) { 363 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 363, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 362, .object = 365, .key = 363 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 363, .value = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 365, .left = 362, .right = 363, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 365, .target_ip = 4906 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4909 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 365, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 363, .src = 365 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4912 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 365, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 363, .src = 365 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4912 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 365, .left = 350, .right = 363, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 365, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 365, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 362, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 364, .string_index = 7 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 366, .object = 362, .key = 364 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 364 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 367, .string_index = 152 } },
    { .opcode = MAL_OP_MERGE_DATA_PROPERTIES, .as.merge_data_properties = { .target = 364, .src = 367 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 367, .callee = 366, .this_value = 362, .argument_count = 1, .arguments = (const i32[]) { 364 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 364, .string_index = 140 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 362, .object = 367, .key = 364 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 364, .string_index = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 366, .callee = 362, .this_value = 367, .argument_count = 1, .arguments = (const i32[]) { 364 } } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 364, .string_index = 197 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 367, .left = 366, .right = 364, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 367, .target_ip = 4930 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4933 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 367, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 364, .src = 367 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4936 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 367, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 364, .src = 367 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4936 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 367, .left = 365, .right = 364, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 367, .index = 178 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 367, .intrinsic = MAL_INTRINSIC_OBJECT_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 366, .string_index = 198 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 362, .object = 367, .key = 366 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 366 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 368, .string_index = 199 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 369, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 366, .key = 368, .value = 369, .enumerable = true } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 369, .callee = 362, .this_value = 367, .argument_count = 1, .arguments = (const i32[]) { 366 } } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 369, .index = 200 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 369, .index = 200 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 366, .string_index = 200 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 367, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 369, .key = 366, .value = 367 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 367, .index = 178 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 366, .string_index = 199 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 369 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 362, .index = 200 } },
    { .opcode = MAL_OP_MERGE_DATA_PROPERTIES, .as.merge_data_properties = { .target = 369, .src = 362 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 362, .left = 366, .right = 369, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 369, .src = 362, .op = MAL_UNARY_NOT } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 362, .src = 369 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 369, .target_ip = 4961 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4968 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 369, .string_index = 200 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 366 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 368, .index = 200 } },
    { .opcode = MAL_OP_MERGE_DATA_PROPERTIES, .as.merge_data_properties = { .target = 366, .src = 368 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 368, .left = 369, .right = 366, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 362, .src = 368 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4968 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 362, .target_ip = 4970 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4973 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 368, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 366, .src = 368 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4976 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 368, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 366, .src = 368 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 4976 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 368, .left = 367, .right = 366, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 368, .index = 178 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 368, .length = 4 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 369, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 370, .value = 0 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 368, .key = 369, .value = 370 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 370, .value = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 369, .value = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 368, .key = 370, .value = 369 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 369, .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 370, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 368, .key = 369, .value = 370 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 370, .value = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 369, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 368, .key = 370, .value = 369 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 368, .index = 201 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 368, .index = 201 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 369, .string_index = 22 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 370, .value = 2 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 368, .key = 369, .value = 370 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 370, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 369, .index = 201 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 368, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 371, .object = 369, .key = 368 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 368, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 369, .left = 371, .right = 368, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 368, .src = 369 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 369, .target_ip = 5005 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 5011 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 369, .value = 2 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 371, .index = 201 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 372, .left = 369, .right = 371, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 371, .src = 372, .op = MAL_UNARY_NOT } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 368, .src = 371 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 5011 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 371, .src = 368 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 368, .target_ip = 5014 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 5020 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 372, .value = 3 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 369, .index = 201 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 373, .left = 372, .right = 369, .op = MAL_BIN_IN } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 369, .src = 373, .op = MAL_UNARY_NOT } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 371, .src = 369 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 5020 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 371, .target_ip = 5022 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 5025 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 369, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 373, .src = 369 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 5028 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 369, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 373, .src = 369 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 5028 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 369, .left = 370, .right = 373, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 369, .index = 178 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 369, .index = 17 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 372, .index = 178 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 374, .left = 369, .right = 372, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 374, .index = 17 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 374, .intrinsic = MAL_INTRINSIC_CONSOLE } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 372, .string_index = 94 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 369, .object = 374, .key = 372 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 372, .string_index = 201 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 375, .index = 147 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 376, .callee = 369, .this_value = 374, .argument_count = 2, .arguments = (const i32[]) { 372, 375 } } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 375, .intrinsic = MAL_INTRINSIC_CONSOLE } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 372, .string_index = 94 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 374, .object = 375, .key = 372 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 372, .string_index = 202 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 369, .index = 178 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 376, .callee = 374, .this_value = 375, .argument_count = 2, .arguments = (const i32[]) { 372, 369 } } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 369, .intrinsic = MAL_INTRINSIC_CONSOLE } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 372, .string_index = 94 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 375, .object = 369, .key = 372 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 372, .string_index = 203 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 374, .index = 17 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 376, .callee = 375, .this_value = 369, .argument_count = 2, .arguments = (const i32[]) { 372, 374 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 374, .index = 17 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 372, .value = 1786 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 369, .left = 374, .right = 372, .op = MAL_BIN_STRICT_NEQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 369, .target_ip = 5057 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 5063 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 369, .intrinsic = MAL_INTRINSIC_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 372, .string_index = 204 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 374, .index = 17 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 375, .left = 372, .right = 374, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 374, .callee = 369, .argument_count = 1, .arguments = (const i32[]) { 375 } } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 374 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 374 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 374 } },
};

static const MalExceptionHandler mal_function_0_handlers[] = {
    { .start_ip = 58, .end_ip = 65, .handler_ip = 71 },
    { .start_ip = 90, .end_ip = 97, .handler_ip = 99 },
    { .start_ip = 578, .end_ip = 594, .handler_ip = 596 },
    { .start_ip = 610, .end_ip = 626, .handler_ip = 628 },
    { .start_ip = 873, .end_ip = 879, .handler_ip = 881 },
    { .start_ip = 907, .end_ip = 913, .handler_ip = 915 },
    { .start_ip = 947, .end_ip = 950, .handler_ip = 952 },
    { .start_ip = 1815, .end_ip = 1820, .handler_ip = 1822 },
    { .start_ip = 1847, .end_ip = 1854, .handler_ip = 1856 },
    { .start_ip = 1870, .end_ip = 1874, .handler_ip = 1876 },
    { .start_ip = 1890, .end_ip = 1895, .handler_ip = 1897 },
    { .start_ip = 2200, .end_ip = 2215, .handler_ip = 2217 },
    { .start_ip = 2258, .end_ip = 2267, .handler_ip = 2269 },
    { .start_ip = 3285, .end_ip = 3293, .handler_ip = 3295 },
    { .start_ip = 3422, .end_ip = 3427, .handler_ip = 3429 },
    { .start_ip = 3450, .end_ip = 3455, .handler_ip = 3457 },
    { .start_ip = 3478, .end_ip = 3482, .handler_ip = 3484 },
    { .start_ip = 3505, .end_ip = 3513, .handler_ip = 3515 },
    { .start_ip = 3821, .end_ip = 3828, .handler_ip = 3830 },
    { .start_ip = 3854, .end_ip = 3861, .handler_ip = 3863 },
    { .start_ip = 3907, .end_ip = 3923, .handler_ip = 3925 },
    { .start_ip = 3953, .end_ip = 3962, .handler_ip = 3964 },
    { .start_ip = 3990, .end_ip = 4003, .handler_ip = 4005 },
    { .start_ip = 4057, .end_ip = 4063, .handler_ip = 4065 },
    { .start_ip = 4049, .end_ip = 4068, .handler_ip = 4070 },
    { .start_ip = 4257, .end_ip = 4265, .handler_ip = 4267 },
    { .start_ip = 4580, .end_ip = 4592, .handler_ip = 4594 },
};

static const MalInstruction mal_function_1_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_2_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 1, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_3_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 8 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 0, .intrinsic = MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 10 } },
    { .opcode = MAL_OP_CONSTRUCT, .as.construct = { .dst = 2, .callee = 0, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_4_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_5_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 1, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_6_instructions[] = {
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 45 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 2, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_7_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 45 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 1, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 0, .key = 2, .value = 4 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 4 } },
};

static const MalInstruction mal_function_8_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_9_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 9 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_10_instructions[] = {
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_11_instructions[] = {
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_12_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 21 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_13_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 3 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_14_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 0, .owner_function_index = 14, .index = 0 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 0, .function_index = 15 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_15_instructions[] = {
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 14, .index = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 2, .owner_function_index = 14, .index = 0 } },
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 2, .owner_function_index = 14, .index = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_16_instructions[] = {
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 0, .owner_function_index = 16, .index = 0 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 0, .function_index = 17 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_17_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 16, .index = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 0, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_18_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 0, .owner_function_index = 18, .index = 0 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 19 } },
    { .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = 0, .key = 1, .accessor = 2, .is_setter = false, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 1, .function_index = 20 } },
    { .opcode = MAL_OP_DEFINE_ACCESSOR, .as.define_accessor = { .object = 0, .key = 2, .accessor = 1, .is_setter = true, .enumerable = true } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_19_instructions[] = {
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 18, .index = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_20_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 0, .owner_function_index = 18, .index = 0 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_21_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 15 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 0, .key = 2, .value = 3 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 3 } },
};

static const MalInstruction mal_function_22_instructions[] = {
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 15 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 71 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 2, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 72 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 1, .key = 2 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 3, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 0, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_23_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_24_instructions[] = {
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 74 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_25_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 0, .index = 1 } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 76 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 0, .this_value = 2, .argument_count = 1, .arguments = (const i32[]) { 3 } } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 3 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 77 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 3, .key = 2, .value = 0 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_26_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 4 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_27_instructions[] = {
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 2, .right = 3, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_28_instructions[] = {
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 0, .index = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 14 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 70 } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 2, .key = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 3, .this_value = 0, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 80 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 0, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 77 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 3, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_29_instructions[] = {
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 0, .index = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 20 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_ARGUMENTS_OBJECT, .as.create_arguments_object = { .dst = 3 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 2, .this_value = 0, .argument_count = 2, .arguments = (const i32[]) { 1, 3 } } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 3 } },
};

static const MalInstruction mal_function_30_instructions[] = {
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 5, .object = 0, .key = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 5 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 5, .string_index = 101 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 6, .object = 0, .key = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 6 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 6, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 7, .target_ip = 11 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 14 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 7, .value = 10 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 14 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 7, .src = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 6 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 8, .left = 1, .right = 6, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 8, .target_ip = 20 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 23 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 8, .length = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 23 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 8, .next_dst = 6, .source = 0 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 1, .done_dst = 9, .iterator = 8, .next = 6 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 9, .src = 1 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 1, .done_dst = 10, .iterator = 8, .next = 6 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 11 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 12, .left = 1, .right = 11, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 12, .target_ip = 32 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 35 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 12, .value = 20 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 12 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 35 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 12, .src = 6 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 10, .target_ip = 39 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 39 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 11, .src = 2 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 13, .left = 2, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 13, .target_ip = 44 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 49 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 13, .src = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 9 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 13, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 11, .src = 2 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 49 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 11 } },
    { .opcode = MAL_OP_CREATE_REST_ARGUMENTS, .as.create_rest_arguments = { .dst = 1, .start_index = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 13, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 14, .src = 7 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 15, .left = 1, .right = 14, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 14, .src = 9 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 15, .right = 14, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 14, .src = 12 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 15, .left = 1, .right = 14, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 14, .src = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 15, .right = 14, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 14, .src = 13 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 13, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 15, .object = 14, .key = 13 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 13, .left = 2, .right = 15, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 13 } },
};

static const MalInstruction mal_function_31_instructions[] = {
    { .opcode = MAL_OP_CREATE_REST_ARGUMENTS, .as.create_rest_arguments = { .dst = 1, .start_index = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 1, .key = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 2 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 0 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 3, .key = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 1, .target_ip = 13 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 13 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 4, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_32_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 5, .left = 1, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 5, .target_ip = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 11 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 5, .right = 4, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 11 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 2 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 6, .left = 2, .right = 5, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 22 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 6, .right = 5, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 2 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 22 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 7, .left = 5, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 7, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_33_instructions[] = {
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 0, .owner_function_index = 33, .index = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 1, .right = 2, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 9 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 3, .function_index = 34 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 9 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 3 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 1, .callee = 2, .this_value = 3, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_34_instructions[] = {
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 33, .index = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_35_instructions[] = {
    { .opcode = MAL_OP_CREATE_ARGUMENTS_OBJECT, .as.create_arguments_object = { .dst = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 5, .left = 0, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 5, .target_ip = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 9 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 5, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 5 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 9 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 4 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 1, .right = 4, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 15 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 18 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 18 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 22 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 1, .object = 0, .key = 4 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_36_instructions[] = {
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 46 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 0, .key = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 3 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 3, .right = 0, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 8 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 11 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 11 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 5, .left = 1, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 5, .target_ip = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 23 } },
    { .opcode = MAL_OP_CREATE_ARRAY, .as.create_array = { .dst = 5, .length = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 3 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 5, .key = 3, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 5 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 23 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 5, .next_dst = 1, .source = 0 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 3, .done_dst = 6, .iterator = 5, .next = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 3 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 6, .target_ip = 29 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 5 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 29 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 5, .src = 4 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 3, .left = 5, .right = 6, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 3 } },
};

static const MalInstruction mal_function_37_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 1, .right = 3, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 9 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 9 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 4 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_38_instructions[] = {
    { .opcode = MAL_OP_CREATE_REST_ARGUMENTS, .as.create_rest_arguments = { .dst = 1, .start_index = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_39_instructions[] = {
    { .opcode = MAL_OP_REQUIRE_COERCIBLE, .as.require_coercible = { .src = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 2 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 0, .key = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 3 } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 3, .next_dst = 2, .source = 1 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 1, .done_dst = 0, .iterator = 3, .next = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 10 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 3 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 10 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 2 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 3 } },
};

static const MalInstruction mal_function_40_instructions[] = {
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_41_instructions[] = {
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_42_instructions[] = {
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_43_instructions[] = {
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_44_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 2, .index = 149 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 139 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 2, .key = 3 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 3, .intrinsic = MAL_INTRINSIC_STRING_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 5 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 6, .src = 0 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 0, .callee = 3, .this_value = 5, .argument_count = 1, .arguments = (const i32[]) { 6 } } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 3, .callee = 4, .this_value = 2, .argument_count = 1, .arguments = (const i32[]) { 0 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 147 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 148 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 2, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 4, .target_ip = 17 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 20 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 4 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 24 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 4, .value = 100 } },
    { .opcode = MAL_OP_UNARY, .as.unary = { .dst = 2, .src = 4, .op = MAL_UNARY_NEGATE } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 24 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 147 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 2 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_45_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 154 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 139 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 3, .object = 0, .key = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 3, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 2 } } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 2, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 11 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 28 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 153 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 144 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 2, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 153 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 135 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 1, .key = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 10 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 2, .this_value = 1, .argument_count = 1, .arguments = (const i32[]) { 0 } } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 153 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 144 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 2, .object = 0, .key = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 20 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 4, .callee = 2, .this_value = 0, .argument_count = 1, .arguments = (const i32[]) { 1 } } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_46_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 0, .owner_function_index = 46, .index = 0 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 142 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 47 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 1, .value = 2, .enumerable = true } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_47_instructions[] = {
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 46, .index = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 2, .owner_function_index = 46, .index = 0 } },
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 2, .owner_function_index = 46, .index = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 2, .right = 1, .op = MAL_BIN_LTE } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 9 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 20 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 2, .owner_function_index = 46, .index = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 10 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 2, .right = 3, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 1, .value = 4, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 151 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 4, .value = 1, .enumerable = true } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 29 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 4, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 3 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 4, .value = 3, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 151 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 4, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 3, .value = 4, .enumerable = true } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 29 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_48_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 42 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_STRICT_EQ } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_49_instructions[] = {
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_50_instructions[] = {
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = { .dst = 2, .intrinsic = MAL_INTRINSIC_SYMBOL_CONSTRUCTOR } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 143 } },
    { .opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = { .dst = 4, .object = 2, .key = 3 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 3, .function_index = 51 } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 0, .key = 4, .value = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 3 } },
};

static const MalInstruction mal_function_51_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 0 } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 0, .owner_function_index = 51, .index = 0 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 142 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 52 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 1, .value = 2, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 173 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 1, .function_index = 53 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 2, .value = 1, .enumerable = true } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_52_instructions[] = {
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 51, .index = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_CAPTURED, .as.store_captured = { .src = 2, .owner_function_index = 51, .index = 0 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 2 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 3 } },
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 0, .owner_function_index = 51, .index = 0 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 2, .key = 1, .value = 0, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 0, .string_index = 151 } },
    { .opcode = MAL_OP_LOAD_CAPTURED, .as.load_captured = { .dst = 1, .owner_function_index = 51, .index = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 3, .value = 5 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 4, .left = 1, .right = 3, .op = MAL_BIN_GT } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 2, .key = 0, .value = 4, .enumerable = true } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_53_instructions[] = {
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 182 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 182 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 2 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_54_instructions[] = {
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 183 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_CALL, .as.call = { .dst = 2, .callee = 0, .this_value = 1, .argument_count = 0, .arguments = nullptr } },
    { .opcode = MAL_OP_GET_ITERATOR, .as.get_iterator = { .iterator_dst = 1, .next_dst = 0, .source = 2 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 5 } },
    { .opcode = MAL_OP_ITERATOR_STEP, .as.iterator_step = { .value_dst = 2, .done_dst = 3, .iterator = 1, .next = 0 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 3, .target_ip = 17 } },
    { .opcode = MAL_OP_TRY_BEGIN },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 2 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 2 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
    { .opcode = MAL_OP_TRY_END },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 5 } },
    { .opcode = MAL_OP_CATCH, .as.caught = { .dst = 2 } },
    { .opcode = MAL_OP_ITERATOR_CLOSE, .as.iterator_close = { .iterator = 1 } },
    { .opcode = MAL_OP_THROW, .as.thrown = { .value = 2 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 2 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalExceptionHandler mal_function_54_handlers[] = {
    { .start_ip = 7, .end_ip = 12, .handler_ip = 14 },
};

static const MalInstruction mal_function_55_instructions[] = {
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 142 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 2, .function_index = 56 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 1, .value = 2, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 173 } },
    { .opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = { .dst = 1, .function_index = 57 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 2, .value = 1, .enumerable = true } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_56_instructions[] = {
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 0 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 1, .string_index = 3 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 2, .value = 1 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 1, .value = 2, .enumerable = true } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 151 } },
    { .opcode = MAL_OP_CREATE_BOOLEAN, .as.create_boolean = { .dst = 1, .value = 0 } },
    { .opcode = MAL_OP_DEFINE_PROPERTY, .as.define_property = { .object = 0, .key = 2, .value = 1, .enumerable = true } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_57_instructions[] = {
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 191 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 2, .index = 191 } },
    { .opcode = MAL_OP_CREATE_OBJECT, .as.create_object = { .dst = 2 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_58_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 3 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 2, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 3, .src = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 1, .left = 0, .right = 3, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_59_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_LOAD_THIS, .as.load_this = { .dst = 1 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 3, .string_index = 179 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 4, .src = 2 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 2, .src = 0 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 0, .left = 4, .right = 2, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_STORE_PROPERTY, .as.store_property = { .object = 1, .key = 3, .value = 0 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 0 } },
};

static const MalInstruction mal_function_60_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_MUL } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalInstruction mal_function_61_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 2 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_REM } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 2, .target_ip = 6 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 9 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 194 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 12 } },
    { .opcode = MAL_OP_CREATE_STRING, .as.create_string = { .dst = 2, .string_index = 195 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 2 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 12 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalInstruction mal_function_62_instructions[] = {
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 1, .src = 0 } },
    { .opcode = MAL_OP_MOVE, .as.move = { .dst = 0, .src = 1 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 1, .value = 3 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_LT } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 2 } },
};

static const MalFunction mal_functions[] = {
    {
        .name_string_index = 0,
        .parameter_count = 0,
        .length = 0,
        .register_count = 377,
        .captured_count = 4,
        .strict = true,
        .instruction_count = 5065,
        .instructions = mal_function_0_instructions,
        .handler_count = 27,
        .handlers = mal_function_0_handlers,
    },
    {
        .name_string_index = 0,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 5,
        .instructions = mal_function_1_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 2,
        .length = 2,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 6,
        .instructions = mal_function_2_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 9,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 10,
        .instructions = mal_function_3_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 13,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_4_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 18,
        .parameter_count = 2,
        .length = 2,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 6,
        .instructions = mal_function_5_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 47,
        .parameter_count = 0,
        .length = 0,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 6,
        .instructions = mal_function_6_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 48,
        .parameter_count = 1,
        .length = 1,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 9,
        .instructions = mal_function_7_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 49,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 5,
        .instructions = mal_function_8_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 51,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_9_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 51,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_10_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 55,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_11_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 57,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_12_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 63,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_13_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 64,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 1,
        .strict = true,
        .instruction_count = 4,
        .instructions = mal_function_14_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 0,
        .length = 0,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 6,
        .instructions = mal_function_15_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 65,
        .parameter_count = 1,
        .length = 1,
        .register_count = 1,
        .captured_count = 1,
        .strict = true,
        .instruction_count = 3,
        .instructions = mal_function_16_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 5,
        .instructions = mal_function_17_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 66,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 1,
        .strict = true,
        .instruction_count = 11,
        .instructions = mal_function_18_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 67,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_19_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 68,
        .parameter_count = 1,
        .length = 1,
        .register_count = 2,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 5,
        .instructions = mal_function_20_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 69,
        .parameter_count = 1,
        .length = 1,
        .register_count = 4,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 7,
        .instructions = mal_function_21_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 70,
        .parameter_count = 0,
        .length = 0,
        .register_count = 4,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 11,
        .instructions = mal_function_22_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 72,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_23_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 73,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_24_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 75,
        .parameter_count = 1,
        .length = 1,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 11,
        .instructions = mal_function_25_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 72,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_26_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 79,
        .parameter_count = 0,
        .length = 0,
        .register_count = 4,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 8,
        .instructions = mal_function_27_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 70,
        .parameter_count = 0,
        .length = 0,
        .register_count = 4,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 14,
        .instructions = mal_function_28_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 0,
        .length = 0,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 8,
        .instructions = mal_function_29_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 100,
        .parameter_count = 4,
        .length = 1,
        .register_count = 16,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 66,
        .instructions = mal_function_30_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 102,
        .parameter_count = 1,
        .length = 0,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 15,
        .instructions = mal_function_31_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 103,
        .parameter_count = 3,
        .length = 1,
        .register_count = 8,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 29,
        .instructions = mal_function_32_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 104,
        .parameter_count = 2,
        .length = 1,
        .register_count = 4,
        .captured_count = 1,
        .strict = true,
        .instruction_count = 14,
        .instructions = mal_function_33_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 105,
        .parameter_count = 0,
        .length = 0,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 4,
        .instructions = mal_function_34_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 106,
        .parameter_count = 2,
        .length = 0,
        .register_count = 6,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 23,
        .instructions = mal_function_35_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 107,
        .parameter_count = 2,
        .length = 1,
        .register_count = 7,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 33,
        .instructions = mal_function_36_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 108,
        .parameter_count = 3,
        .length = 1,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 13,
        .instructions = mal_function_37_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 109,
        .parameter_count = 1,
        .length = 0,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 4,
        .instructions = mal_function_38_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 110,
        .parameter_count = 2,
        .length = 2,
        .register_count = 4,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 12,
        .instructions = mal_function_39_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 118,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_40_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 119,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_41_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 120,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_42_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 121,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_43_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 3,
        .length = 3,
        .register_count = 7,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 28,
        .instructions = mal_function_44_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 1,
        .length = 1,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 30,
        .instructions = mal_function_45_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 0,
        .length = 0,
        .register_count = 3,
        .captured_count = 1,
        .strict = true,
        .instruction_count = 7,
        .instructions = mal_function_46_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 142,
        .parameter_count = 0,
        .length = 0,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 30,
        .instructions = mal_function_47_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 5,
        .instructions = mal_function_48_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 166,
        .parameter_count = 0,
        .length = 0,
        .register_count = 1,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 2,
        .instructions = mal_function_49_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 172,
        .parameter_count = 0,
        .length = 0,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 10,
        .instructions = mal_function_50_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 0,
        .length = 0,
        .register_count = 3,
        .captured_count = 1,
        .strict = true,
        .instruction_count = 10,
        .instructions = mal_function_51_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 142,
        .parameter_count = 0,
        .length = 0,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 14,
        .instructions = mal_function_52_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 173,
        .parameter_count = 0,
        .length = 0,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 6,
        .instructions = mal_function_53_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 0,
        .length = 0,
        .register_count = 4,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 19,
        .instructions = mal_function_54_instructions,
        .handler_count = 1,
        .handlers = mal_function_54_handlers,
    },
    {
        .name_string_index = 0,
        .parameter_count = 0,
        .length = 0,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 8,
        .instructions = mal_function_55_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 142,
        .parameter_count = 0,
        .length = 0,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 8,
        .instructions = mal_function_56_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 173,
        .parameter_count = 0,
        .length = 0,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 6,
        .instructions = mal_function_57_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 177,
        .parameter_count = 3,
        .length = 3,
        .register_count = 4,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 9,
        .instructions = mal_function_58_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 178,
        .parameter_count = 2,
        .length = 2,
        .register_count = 5,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 10,
        .instructions = mal_function_59_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 5,
        .instructions = mal_function_60_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 13,
        .instructions = mal_function_61_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
    {
        .name_string_index = 0,
        .parameter_count = 1,
        .length = 1,
        .register_count = 3,
        .captured_count = 0,
        .strict = true,
        .instruction_count = 5,
        .instructions = mal_function_62_instructions,
        .handler_count = 0,
        .handlers = nullptr,
    },
};

const MalVmDefinition mal_vm_definition = {
    .function_count = 63,
    .functions = mal_functions,
    .string_constant_count = 205,
    .string_constants = mal_string_constants,
    .global_count = 202,
};
// === END GENERATED ===

static MalPropertyDesc test_data_desc(MalValue value, MalPropertyFlags flags) {
    return (MalPropertyDesc){
        .flags = flags,
        .value = value,
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
}

static MalValue test_native_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    (void) args;

    return mal_value_from_i32(arg_count);
}

static void test_binary_value_ops_handle_int32_arithmetic(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);
    MalValue seven = mal_value_from_i32(7);
    MalValue two = mal_value_from_i32(2);

    assert(mal_value_to_i32(mal_ops_add(&heap, seven, two)) == 9);
    assert(mal_value_to_i32(mal_ops_subtract(seven, two)) == 5);
    assert(mal_value_to_i32(mal_ops_multiply(seven, two)) == 14);
    assert(mal_value_to_i32(mal_ops_remainder(seven, two)) == 1);

    mal_heap_free(&heap);
}

static void test_binary_value_ops_handle_bitwise_operations(void) {
    MalValue seven = mal_value_from_i32(7);
    MalValue two = mal_value_from_i32(2);
    MalValue negative_one = mal_value_from_i32(-1);

    assert(mal_value_to_i32(mal_ops_bit_and(seven, two)) == 2);
    assert(mal_value_to_i32(mal_ops_bit_or(seven, two)) == 7);
    assert(mal_value_to_i32(mal_ops_bit_xor(seven, two)) == 5);
    assert(mal_value_to_i32(mal_ops_shift_left(seven, two)) == 28);
    assert(mal_value_to_i32(mal_ops_shift_right(mal_value_from_i32(-8), two)) == -2);
    assert(mal_value_to_f64(mal_ops_shift_right_unsigned(negative_one, mal_value_from_i32(0))) == 4294967295.0);
}

static void test_string_values_use_utf16_code_unit_length(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    c16 pile_of_poo[] = {0xD83D, 0xDCA9};
    MalString *string = mal_string_new_copy(&heap, pile_of_poo, countof(pile_of_poo));

    assert(mal_string_length(string) == 2);
    assert(mal_string_code_units(string)[0] == 0xD83D);
    assert(mal_string_code_units(string)[1] == 0xDCA9);

    mal_heap_free(&heap);
}

static void test_string_value_ops_concatenate_and_convert_values(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalValue left = mal_value_from_string(mal_string_new_ascii(&heap, "a", lengthof("a")));
    MalValue result = mal_ops_add(&heap, left, mal_value_from_i32(1));
    MalString *string = mal_value_to_string(result);

    assert(mal_string_length(string) == 2);
    assert(mal_string_code_units(string)[0] == 'a');
    assert(mal_string_code_units(string)[1] == '1');
    assert(mal_value_to_i32(mal_ops_subtract(
        mal_value_from_string(mal_string_new_ascii(&heap, "7", lengthof("7"))),
        mal_value_from_i32(2)
    )) == 5);

    mal_heap_free(&heap);
}

static void test_string_value_ops_compare_strings_and_converted_numbers(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalValue a = mal_value_from_string(mal_string_new_ascii(&heap, "a", lengthof("a")));
    MalValue b = mal_value_from_string(mal_string_new_ascii(&heap, "b", lengthof("b")));
    MalValue ten = mal_value_from_string(mal_string_new_ascii(&heap, "10", lengthof("10")));
    MalValue two = mal_value_from_string(mal_string_new_ascii(&heap, "2", lengthof("2")));

    assert(mal_value_to_boolean(mal_ops_less_than(a, b)));
    assert(mal_value_to_boolean(mal_ops_greater_equal(b, b)));
    assert(mal_value_to_boolean(mal_ops_less_than(ten, two)));
    assert(!mal_value_to_boolean(mal_ops_less_than(mal_value_from_i32(10), two)));
    assert(mal_value_to_boolean(mal_ops_strict_equal(
        mal_value_from_string(mal_string_new_ascii(&heap, "abc", lengthof("abc"))),
        mal_value_from_string(mal_string_new_ascii(&heap, "abc", lengthof("abc")))
    )));
    assert(mal_value_to_boolean(mal_ops_equal(
        mal_value_from_string(mal_string_new_ascii(&heap, "1", lengthof("1"))),
        mal_value_from_i32(1)
    )));

    mal_heap_free(&heap);
}

static void test_vm_binary_op_dispatches_all_binary_operators(void) {
    MalVm vm;
    MalCallable callable = {.vm = &vm, .function = NULL, .registers = (MalValue[3]){0}, .instruction_pointer = 0};
    MalInstruction instruction = {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 2, .left = 0, .right = 1}};

    callable.registers[0] = mal_value_from_i32(7);
    callable.registers[1] = mal_value_from_i32(2);

    instruction.as.binary.op = MAL_BIN_ADD;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 9);

    instruction.as.binary.op = MAL_BIN_SUB;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 5);

    instruction.as.binary.op = MAL_BIN_MUL;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 14);

    instruction.as.binary.op = MAL_BIN_REM;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 1);

    instruction.as.binary.op = MAL_BIN_BIT_AND;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 2);

    instruction.as.binary.op = MAL_BIN_BIT_OR;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 7);

    instruction.as.binary.op = MAL_BIN_BIT_XOR;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 5);

    instruction.as.binary.op = MAL_BIN_SHL;
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == 28);

    instruction.as.binary.op = MAL_BIN_SHR;
    callable.registers[0] = mal_value_from_i32(-8);
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_i32(callable.registers[2]) == -2);

    instruction.as.binary.op = MAL_BIN_USHR;
    callable.registers[0] = mal_value_from_i32(-1);
    callable.registers[1] = mal_value_from_i32(0);
    mal_op_binary(&callable, &instruction);
    assert(mal_value_to_f64(callable.registers[2]) == 4294967295.0);
}

static void test_vm_call_frame_returns_to_caller(void) {
    static const i32 call_arguments[] = {1, 2};
    static const MalInstruction caller_instructions[] = {
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 2}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 3}},
        {.opcode = MAL_OP_CALL, .as.call = {.dst = 3, .callee = 0, .argument_count = 2, .arguments = call_arguments}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 3}},
    };
    static const MalInstruction callee_instructions[] = {
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 2}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 4, .captured_count = 0, .instruction_count = 6,
            .instructions = caller_instructions
        },
        {
            .parameter_count = 2, .register_count = 3, .captured_count = 0, .instruction_count = 2,
            .instructions = callee_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 2, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 1
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(mal_value_to_i32(vm.globals[0]) == 5);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_call_frame_fills_missing_parameters_with_undefined(void) {
    static const i32 call_arguments[] = {1};
    static const MalInstruction caller_instructions[] = {
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 2}},
        {.opcode = MAL_OP_CALL, .as.call = {.dst = 2, .callee = 0, .argument_count = 1, .arguments = call_arguments}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 2}},
    };
    static const MalInstruction callee_instructions[] = {
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 1}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 3, .captured_count = 0, .instruction_count = 5,
            .instructions = caller_instructions
        },
        {
            .parameter_count = 2, .register_count = 2, .captured_count = 0, .instruction_count = 1,
            .instructions = callee_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 2, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 1
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(mal_value_is_undefined(vm.globals[0]));

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_create_string_uses_utf16_string_constants(void) {
    static const c16 code_units[] = {'o', 'k', 0xD83D, 0xDCA9};
    static const MalStringConstant string_constants[] = {
        {.length = countof(code_units), .code_units = code_units},
    };
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 0, .string_index = 0}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 0, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 1, .captured_count = 0, .instruction_count = countof(instructions),
            .instructions = instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1,
        .functions = functions,
        .string_constant_count = countof(string_constants),
        .string_constants = string_constants,
        .global_count = 1,
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    MalString *string = mal_value_to_string(vm.globals[0]);
    assert(mal_string_length(string) == 4);
    assert(mal_string_code_units(string)[2] == 0xD83D);
    assert(mal_string_code_units(string)[3] == 0xDCA9);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_object_property_ops_create_read_and_write_properties(void) {
    static const c16 name_units[] = {'f', 'o', 'o'};
    static const c16 index_units[] = {'0'};
    static const MalStringConstant string_constants[] = {
        {.length = countof(name_units), .code_units = name_units},
        {.length = countof(index_units), .code_units = index_units},
    };
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_CREATE_OBJECT, .as.create_object = {.dst = 0}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 0}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 3}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 1, .value = 2}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 3, .value = 2}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 4, .object = 0, .key = 1}},
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 5, .left = 4, .right = 3, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 1, .value = 5}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 6, .value = 0}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 7, .value = 8}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 6, .value = 7}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 8, .string_index = 1}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 9, .object = 0, .key = 8}},
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 10, .left = 5, .right = 9, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 10, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 10}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 11, .captured_count = 0, .instruction_count = countof(instructions),
            .instructions = instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1,
        .functions = functions,
        .string_constant_count = countof(string_constants),
        .string_constants = string_constants,
        .global_count = 1,
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(mal_value_to_i32(vm.globals[0]) == 13);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_array_property_ops_manage_indices_and_length(void) {
    static const c16 length_units[] = {'l', 'e', 'n', 'g', 't', 'h'};
    static const c16 zero_units[] = {'0'};
    static const MalStringConstant string_constants[] = {
        {.length = countof(length_units), .code_units = length_units},
        {.length = countof(zero_units), .code_units = zero_units},
    };
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_CREATE_ARRAY, .as.create_array = {.dst = 0, .length = 3}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 0}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 4}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 1, .value = 2}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 3, .string_index = 1}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 4, .object = 0, .key = 3}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 5, .value = 5}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 6, .value = 9}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 5, .value = 6}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 7, .string_index = 0}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 8, .object = 0, .key = 7}},
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 9, .left = 4, .right = 8, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 9, .index = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 9}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 10, .captured_count = 0, .instruction_count = countof(instructions),
            .instructions = instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1,
        .functions = functions,
        .string_constant_count = countof(string_constants),
        .string_constants = string_constants,
        .global_count = 1,
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(mal_value_to_i32(vm.globals[0]) == 10);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_object_new_initializes_base_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *prototype = mal_object_new(&heap, NULL);
    MalObject *object = mal_object_new(&heap, prototype);

    assert(object != NULL);
    assert(object->header.type == MAL_HEAP_OBJECT);
    assert(object->prototype == prototype);
    assert(object->extensible);
    assert(object->properties != NULL);
    assert(mal_table_mode(object->properties) == MAL_TABLE_MODE_OBJECT);
    assert(mal_table_size(object->properties) == 0);

    mal_heap_free(&heap);
}

static void test_string_new_copy_owns_byte_storage(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    c16 code_units[] = {'a', 'b', 'c'};
    MalString *string = mal_string_new_copy(&heap, code_units, countof(code_units));
    code_units[0] = 'z';

    assert(string != NULL);
    assert(string->header.type == MAL_HEAP_STRING);
    assert(mal_string_storage(string) == MAL_STRING_STORAGE_OWNED);
    assert(mal_string_length(string) == countof(code_units));
    assert(mal_string_code_units(string) != code_units);
    assert(mal_string_code_units(string)[0] == 'a');
    assert(mal_string_code_units(string)[1] == 'b');
    assert(mal_string_code_units(string)[2] == 'c');
    assert(mal_value_is_string(mal_value_from_string(string)));

    mal_heap_free(&heap);
}

static void test_string_new_external_borrows_code_unit_storage(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    c16 code_units[] = {'a', 'b', 'c'};
    MalString *string = mal_string_new_external(&heap, code_units, countof(code_units));

    assert(string != NULL);
    assert(string->header.type == MAL_HEAP_STRING);
    assert(mal_string_storage(string) == MAL_STRING_STORAGE_EXTERNAL);
    assert(mal_string_length(string) == countof(code_units));
    assert(mal_string_code_units(string) == code_units);

    mal_heap_free(&heap);
}

static void test_symbol_new_stores_optional_description(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalString *description = mal_string_new_ascii(&heap, "desc", lengthof("desc"));
    MalSymbol *symbol = mal_symbol_new(&heap, description);
    MalSymbol *anonymous = mal_symbol_new(&heap, NULL);

    assert(symbol != NULL);
    assert(symbol->header.type == MAL_HEAP_SYMBOL);
    assert(mal_symbol_description(symbol) == description);
    assert(mal_symbol_description(anonymous) == NULL);
    assert(symbol != anonymous);
    assert(mal_value_is_symbol(mal_value_from_symbol(symbol)));

    mal_heap_free(&heap);
}

static void test_table_uses_structural_string_keys_and_identity_symbol_keys(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalTable *table = mal_table_new(MAL_TABLE_MODE_OBJECT);
    MalString *left = mal_string_new_ascii(&heap, "key", lengthof("key"));
    MalString *right = mal_string_new_ascii(&heap, "key", lengthof("key"));
    MalSymbol *left_symbol = mal_symbol_new(&heap, left);
    MalSymbol *right_symbol = mal_symbol_new(&heap, left);

    MalKey string_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(left)};
    MalKey equivalent_string_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(right)};
    MalKey symbol_key = {.kind = MAL_KEY_SYMBOL, .value = mal_value_from_symbol(left_symbol)};
    MalKey different_symbol_key = {.kind = MAL_KEY_SYMBOL, .value = mal_value_from_symbol(right_symbol)};

    void *string_entry = mal_table_upsert_entry(table, string_key);
    void *symbol_entry = mal_table_upsert_entry(table, symbol_key);

    MalTableLookup string_lookup = mal_table_lookup(table, equivalent_string_key);
    MalTableLookup symbol_lookup = mal_table_lookup(table, different_symbol_key);

    assert(string_lookup.present);
    assert(string_lookup.entry == string_entry);
    assert(!symbol_lookup.present);
    assert(symbol_entry != NULL);
    assert(mal_table_size(table) == 2);

    mal_table_free(table);
    mal_heap_free(&heap);
}

static void test_property_define_lookup_and_entry_accessors(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalTable *table = mal_table_new(MAL_TABLE_MODE_OBJECT);
    MalString *name = mal_string_new_ascii(&heap, "name", lengthof("name"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc first = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_ENUMERABLE);
    MalPropertyDesc second = test_data_desc(mal_value_from_i32(2), MAL_PROPERTY_WRITABLE);

    void *entry = mal_property_define(table, key, &first);
    MalPropertyLookup lookup = mal_property_lookup(table, key);

    assert(lookup.present);
    assert(lookup.entry == entry);
    assert(mal_value_to_i32(lookup.desc.value) == 1);
    assert(lookup.desc.flags == MAL_PROPERTY_ENUMERABLE);
    assert(mal_property_entry_key(table, entry).value == key.value);

    mal_property_write_entry(table, entry, &second);

    MalPropertyDesc written = mal_property_entry_desc(table, entry);

    assert(mal_value_to_i32(written.value) == 2);
    assert(written.flags == MAL_PROPERTY_WRITABLE);
    assert(mal_table_size(table) == 1);

    mal_table_free(table);
    mal_heap_free(&heap);
}

static void test_property_set_value_creates_default_data_descriptor(void) {
    MalTable *table = mal_table_new(MAL_TABLE_MODE_OBJECT);
    MalKey key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)};

    void *entry = mal_property_set_value(table, key, mal_value_from_i32(42));
    MalPropertyDesc desc = mal_property_entry_desc(table, entry);

    assert(desc.flags == (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE));
    assert(mal_value_to_i32(desc.value) == 42);
    assert(mal_value_is_undefined(desc.getter));
    assert(mal_value_is_undefined(desc.setter));

    mal_table_free(table);
}

static void test_property_iter_storage_order_yields_insertion_order(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *a = mal_string_new_ascii(&heap, "a", lengthof("a"));
    MalString *b = mal_string_new_ascii(&heap, "b", lengthof("b"));
    MalKey first = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(a)};
    MalKey second = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(2)};
    MalKey third = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(b)};
    MalPropertyDesc desc = test_data_desc(mal_value_new_undefined(), MAL_PROPERTY_ENUMERABLE);

    mal_property_define(object->properties, first, &desc);
    mal_property_define(object->properties, second, &desc);
    mal_property_define(object->properties, third, &desc);

    MalPropertyIter iter;
    MalKey key;
    MalPropertyDesc out_desc;

    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_STORAGE_ORDER);

    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == first.value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == second.value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == third.value);
    assert(!mal_property_iter_next(&iter, &key, &out_desc));

    mal_heap_free(&heap);
}

static void test_property_iter_own_property_order_groups_index_string_and_symbol_keys(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *a = mal_string_new_ascii(&heap, "a", lengthof("a"));
    MalString *b = mal_string_new_ascii(&heap, "b", lengthof("b"));
    MalSymbol *left_symbol = mal_symbol_new(&heap, a);
    MalSymbol *right_symbol = mal_symbol_new(&heap, b);
    MalKey keys[] = {
        {.kind = MAL_KEY_STRING, .value = mal_value_from_string(a)},
        {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(2)},
        {.kind = MAL_KEY_SYMBOL, .value = mal_value_from_symbol(left_symbol)},
        {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)},
        {.kind = MAL_KEY_STRING, .value = mal_value_from_string(b)},
        {.kind = MAL_KEY_SYMBOL, .value = mal_value_from_symbol(right_symbol)},
    };
    MalPropertyDesc desc = test_data_desc(mal_value_new_undefined(), MAL_PROPERTY_ENUMERABLE);

    for (usize i = 0; i < countof(keys); i++) {
        mal_property_define(object->properties, keys[i], &desc);
    }

    MalPropertyIter iter;
    MalKey key;
    MalPropertyDesc out_desc;

    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);

    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.kind == MAL_KEY_INDEX && mal_value_to_i32(key.value) == 1);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.kind == MAL_KEY_INDEX && mal_value_to_i32(key.value) == 2);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == keys[0].value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == keys[4].value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == keys[2].value);
    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == keys[5].value);
    assert(!mal_property_iter_next(&iter, &key, &out_desc));

    mal_heap_free(&heap);
}

static void test_property_iter_enumerable_own_property_order_skips_non_enumerable_entries(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *visible = mal_string_new_ascii(&heap, "visible", lengthof("visible"));
    MalString *hidden = mal_string_new_ascii(&heap, "hidden", lengthof("hidden"));
    MalKey visible_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(visible)};
    MalKey hidden_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(hidden)};
    MalPropertyDesc enumerable = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_ENUMERABLE);
    MalPropertyDesc non_enumerable = test_data_desc(mal_value_from_i32(2), MAL_PROPERTY_NONE);

    mal_property_define(object->properties, hidden_key, &non_enumerable);
    mal_property_define(object->properties, visible_key, &enumerable);

    MalPropertyIter iter;
    MalKey key;
    MalPropertyDesc out_desc;

    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

    assert(mal_property_iter_next(&iter, &key, &out_desc));
    assert(key.value == visible_key.value);
    assert(mal_value_to_i32(out_desc.value) == 1);
    assert(!mal_property_iter_next(&iter, &key, &out_desc));

    mal_heap_free(&heap);
}

static void test_object_ops_manage_extensibility_and_prototype_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *root = mal_object_new(&heap, NULL);
    MalObject *child = mal_object_new(&heap, root);

    assert(mal_object_properties(child) == child->properties);
    assert(mal_object_is_extensible(child));
    assert(mal_object_get_prototype(child) == root);
    assert(mal_object_set_prototype(root, child) == false);

    mal_object_set_extensible(child, false);

    assert(!mal_object_is_extensible(child));
    // OrdinarySetPrototypeOf: a non-extensible object only accepts its
    // current prototype.
    assert(mal_object_set_prototype(child, NULL) == false);
    assert(mal_object_get_prototype(child) == root);
    assert(mal_object_set_prototype(child, root));

    mal_heap_free(&heap);
}

static void test_object_define_own_rejects_new_properties_on_non_extensible_objects(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *name = mal_string_new_ascii(&heap, "name", lengthof("name"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc desc = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_ENUMERABLE);

    mal_object_set_extensible(object, false);

    assert(mal_object_define_own(object, key, &desc) == MAL_DEFINE_OWN_REJECTED);
    assert(!mal_object_get_own(object, key).present);

    mal_heap_free(&heap);
}

static void test_object_define_own_rejects_incompatible_non_configurable_changes(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *name = mal_string_new_ascii(&heap, "fixed", lengthof("fixed"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc fixed = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_NONE);
    MalPropertyDesc changed = test_data_desc(mal_value_from_i32(2), MAL_PROPERTY_NONE);

    assert(mal_object_define_own(object, key, &fixed) == MAL_DEFINE_OWN_APPLIED);
    assert(mal_object_define_own(object, key, &changed) == MAL_DEFINE_OWN_REJECTED);
    assert(mal_value_to_i32(mal_object_get_own(object, key).desc.value) == 1);

    mal_heap_free(&heap);
}

static void test_object_delete_own_respects_configurable_flag(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *fixed_name = mal_string_new_ascii(&heap, "fixed", lengthof("fixed"));
    MalString *loose_name = mal_string_new_ascii(&heap, "loose", lengthof("loose"));
    MalKey fixed_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(fixed_name)};
    MalKey loose_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(loose_name)};
    MalPropertyDesc fixed = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_NONE);
    MalPropertyDesc loose = test_data_desc(mal_value_from_i32(2), MAL_PROPERTY_CONFIGURABLE);

    mal_object_define_own(object, fixed_key, &fixed);
    mal_object_define_own(object, loose_key, &loose);

    assert(!mal_object_delete_own(object, fixed_key));
    assert(mal_object_get_own(object, fixed_key).present);
    assert(mal_object_delete_own(object, loose_key));
    assert(!mal_object_get_own(object, loose_key).present);

    mal_heap_free(&heap);
}

static void test_object_resolve_property_walks_prototype_chain(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *root = mal_object_new(&heap, NULL);
    MalObject *child = mal_object_new(&heap, root);
    MalString *name = mal_string_new_ascii(&heap, "inherited", lengthof("inherited"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc desc = test_data_desc(mal_value_from_i32(7), MAL_PROPERTY_ENUMERABLE);

    mal_object_define_own(root, key, &desc);

    MalPropertyResolution resolution = mal_object_resolve_property(child, key);

    assert(resolution.found);
    assert(!resolution.own);
    assert(resolution.holder == root);
    assert(mal_value_to_i32(resolution.desc.value) == 7);

    mal_heap_free(&heap);
}

static void test_object_set_updates_writable_own_properties_and_creates_new_properties(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *name = mal_string_new_ascii(&heap, "value", lengthof("value"));
    MalString *new_name = mal_string_new_ascii(&heap, "new", lengthof("new"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalKey new_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(new_name)};
    MalPropertyDesc desc = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_object_define_own(object, key, &desc);

    assert(mal_object_set(object, key, mal_value_from_i32(2)));
    assert(mal_value_to_i32(mal_object_get_own(object, key).desc.value) == 2);
    assert(mal_object_set(object, new_key, mal_value_from_i32(3)));
    assert(mal_value_to_i32(mal_object_get_own(object, new_key).desc.value) == 3);

    mal_heap_free(&heap);
}

static void test_object_set_rejects_non_writable_data_properties(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *object = mal_object_new(&heap, NULL);
    MalString *name = mal_string_new_ascii(&heap, "fixed", lengthof("fixed"));
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(name)};
    MalPropertyDesc desc = test_data_desc(mal_value_from_i32(1), MAL_PROPERTY_CONFIGURABLE);

    mal_object_define_own(object, key, &desc);

    assert(!mal_object_set(object, key, mal_value_from_i32(2)));
    assert(mal_value_to_i32(mal_object_get_own(object, key).desc.value) == 1);

    mal_heap_free(&heap);
}

static void test_function_object_new_initializes_script_function_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *prototype = mal_object_new(&heap, NULL);
    MalFunctionObject *function = mal_function_object_new(&heap, prototype, 12);

    assert(function != NULL);
    assert(function->object.header.type == MAL_HEAP_FUNCTION_OBJECT);
    assert(function->object.prototype == prototype);
    assert(function->object.extensible);
    assert(mal_function_object_function_index(function) == 12);
    assert(mal_value_is_function_object(mal_value_from_function_object(function)));
    assert(mal_value_is_callable(mal_value_from_function_object(function)));

    mal_heap_free(&heap);
}

static void test_native_function_object_new_initializes_native_function_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalString *name = mal_string_new_ascii(&heap, "native", lengthof("native"));
    MalNativeFunctionObject *function = mal_native_function_object_new(&heap, NULL, name, test_native_callback);
    MalNativeFunctionCallback callback = mal_native_function_object_callback(function);

    assert(function != NULL);
    assert(function->object.header.type == MAL_HEAP_NATIVE_FUNCTION_OBJECT);
    assert(mal_native_function_object_name(function) == name);
    assert(callback == test_native_callback);
    assert(mal_value_to_i32(callback(NULL, mal_value_new_undefined(), NULL, 4, mal_value_new_undefined())) == 4);
    assert(mal_value_is_native_function_object(mal_value_from_native_function_object(function)));
    assert(mal_value_is_callable(mal_value_from_native_function_object(function)));

    mal_heap_free(&heap);
}

static void test_array_object_new_initializes_array_state(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);

    MalObject *prototype = mal_object_new(&heap, NULL);
    MalArrayObject *array = mal_array_object_new(&heap, prototype);

    assert(array != NULL);
    assert(array->object.header.type == MAL_HEAP_ARRAY_OBJECT);
    assert(array->object.prototype == prototype);
    assert(array->object.extensible);
    assert(mal_array_object_length(array) == 0);

    mal_array_object_set_length(array, 10);

    assert(mal_array_object_length(array) == 10);
    assert(mal_value_is_array_object(mal_value_from_array_object(array)));
    assert(mal_value_is_object(mal_value_from_array_object(array)));

    mal_heap_free(&heap);
}

static MalValue test_builtin_get(MalVm *vm, MalValue owner, const byte *name) {
    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(owner),
        mal_intrinsic_string_key(vm, name)
    );
    assert(resolution.found);
    return resolution.desc.value;
}

static MalValue test_builtin_call(MalVm *vm, MalValue callee, MalValue this_value, const MalValue *args, i32 arg_count) {
    MalCompletion completion = mal_vm_call_value(vm, callee, this_value, args, arg_count);
    assert(completion.kind == MAL_COMPLETION_NORMAL);
    return completion.value;
}

static MalValue test_builtin_index(MalValue array, i32 index) {
    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(array),
        (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(index)}
    );
    return resolution.found ? resolution.desc.value : mal_value_new_undefined();
}

static bool test_builtin_value_is_ascii(MalVm *vm, MalValue value, const byte *expected) {
    return mal_value_is_string(value) && mal_string_equals(mal_value_to_string(value), mal_intrinsic_ascii(vm, expected));
}

static MalValue test_builtin_double_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    assert(arg_count == 3);
    return mal_value_from_i32(mal_value_to_i32(args[0]) * 2);
}

static MalValue test_builtin_is_even_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    assert(arg_count == 3);
    return mal_value_new_boolean(mal_value_to_i32(args[0]) % 2 == 0);
}

static MalValue test_builtin_sum_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    assert(arg_count == 4);
    return mal_value_from_i32(mal_value_to_i32(args[0]) + mal_value_to_i32(args[1]));
}

static i32 test_builtin_for_each_sum = 0;

static MalValue test_builtin_for_each_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    assert(arg_count == 3);
    test_builtin_for_each_sum += mal_value_to_i32(args[0]);
    return mal_value_new_undefined();
}

static MalValue test_builtin_native_function(MalVm *vm, const byte *name, MalNativeFunctionCallback callback) {
    return mal_value_from_native_function_object(mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, name),
        callback
    ));
}

static MalValue test_builtin_call_throws(MalVm *vm, MalValue callee, MalValue this_value, const MalValue *args, i32 arg_count, const byte *expected_name) {
    MalCompletion completion = mal_vm_call_value(vm, callee, this_value, args, arg_count);
    assert(completion.kind == MAL_COMPLETION_THROW);
    assert(mal_value_is_object(completion.value));
    assert(test_builtin_value_is_ascii(vm, test_builtin_get(vm, completion.value, "name"), expected_name));

    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    return completion.value;
}

static void test_builtin_error_constructors_and_to_string(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue boom = mal_value_from_string(mal_intrinsic_ascii(&vm, "boom"));
    MalValue error = test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR], mal_value_new_undefined(), &boom, 1);
    assert(mal_value_is_object(error));
    assert(mal_object_get_prototype(mal_value_to_object(error)) == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE]));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, error, "message"), "boom"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, error, "name"), "Error"));

    MalValue to_string = test_builtin_get(&vm, error, "toString");
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, error, NULL, 0), "Error: boom"));

    MalValue empty_error = test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR], mal_value_new_undefined(), NULL, 0);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, empty_error, NULL, 0), "Error"));

    MalValue type_error = test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR], mal_value_new_undefined(), &boom, 1);
    MalObject *type_error_prototype = mal_object_get_prototype(mal_value_to_object(type_error));
    assert(type_error_prototype == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE]));
    assert(mal_object_get_prototype(type_error_prototype) == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE]));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, type_error, "name"), "TypeError"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, type_error, NULL, 0), "TypeError: boom"));

    mal_vm_free(&vm);
}

static void test_vm_throw_error_sets_completion_and_builtins_throw(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    mal_vm_throw_error(&vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "nope");
    assert(vm.completion.kind == MAL_COMPLETION_THROW);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, vm.completion.value, "name"), "TypeError"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, vm.completion.value, "message"), "nope"));
    vm.completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    // Reduce of an empty array without an initial value throws a TypeError.
    MalValue empty = mal_value_from_array_object(mal_intrinsic_new_array(&vm, 0));
    MalValue sum = test_builtin_native_function(&vm, "sum", test_builtin_sum_callback);
    test_builtin_call_throws(
        &vm,
        test_builtin_get(&vm, vm.intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE], "reduce"),
        empty,
        &sum,
        1,
        "TypeError"
    );

    // Object.create with a non-object prototype throws a TypeError.
    MalValue bad_prototype = mal_value_from_i32(5);
    test_builtin_call_throws(
        &vm,
        test_builtin_get(&vm, vm.intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR], "create"),
        mal_value_new_undefined(),
        &bad_prototype,
        1,
        "TypeError"
    );

    mal_vm_free(&vm);
}

static void test_vm_try_catch_unwinds_to_handler(void) {
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 42}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 0}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 7}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 0}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalExceptionHandler handlers[] = {
        {.start_ip = 0, .end_ip = 4, .handler_ip = 5},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 2, .captured_count = 0, .instruction_count = 9,
            .instructions = instructions, .handler_count = 1, .handlers = handlers
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 1
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    assert(mal_value_to_i32(vm.globals[0]) == 42);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_nested_try_picks_innermost_handler_and_rethrows(void) {
    static const MalInstruction instructions[] = {
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 1}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 0}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 11}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 0}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 2}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 2}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 14}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 3}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 1}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    // The outer handler is listed first on purpose: innermost selection must
    // come from range width, not table order.
    static const MalExceptionHandler handlers[] = {
        {.start_ip = 0, .end_ip = 10, .handler_ip = 12},
        {.start_ip = 1, .end_ip = 4, .handler_ip = 6},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 4, .captured_count = 0, .instruction_count = 16,
            .instructions = instructions, .handler_count = 2, .handlers = handlers
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 2
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    assert(mal_value_to_i32(vm.globals[0]) == 1);
    assert(mal_value_to_i32(vm.globals[1]) == 2);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_throw_unwinds_across_call_frames(void) {
    static const MalInstruction caller_instructions[] = {
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 1}},
        {.opcode = MAL_OP_CALL, .as.call = {.dst = 2, .callee = 0, .this_value = 1, .argument_count = 0, .arguments = NULL}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 8}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 3}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 0}},
        // Calling a non-function throws a TypeError.
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 5}},
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_CALL, .as.call = {.dst = 1, .callee = 0, .this_value = 0, .argument_count = 0, .arguments = NULL}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 15}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 2}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 1}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalInstruction callee_instructions[] = {
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 9}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 0}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalExceptionHandler caller_handlers[] = {
        {.start_ip = 0, .end_ip = 5, .handler_ip = 6},
        {.start_ip = 9, .end_ip = 12, .handler_ip = 13},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 4, .captured_count = 0, .instruction_count = 17,
            .instructions = caller_instructions, .handler_count = 2, .handlers = caller_handlers
        },
        {
            .parameter_count = 0, .register_count = 1, .captured_count = 0, .instruction_count = 4,
            .instructions = callee_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 2, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 2
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    assert(vm.frame_count == 0);
    assert(mal_value_to_i32(vm.globals[0]) == 9);
    assert(mal_value_is_object(vm.globals[1]));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, vm.globals[1], "name"), "TypeError"));

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_vm_uncaught_throw_propagates_through_call_value(void) {
    static const MalInstruction throwing_instructions[] = {
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 9}},
        {.opcode = MAL_OP_THROW, .as.thrown = {.value = 0}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 1, .captured_count = 0, .instruction_count = 4,
            .instructions = throwing_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 0
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);

    MalFunctionObject *function = mal_function_object_new(&vm.heap, NULL, 0);
    MalCompletion completion = mal_vm_call_value(&vm, mal_value_from_function_object(function), mal_value_new_undefined(), NULL, 0);

    assert(completion.kind == MAL_COMPLETION_THROW);
    assert(mal_value_to_i32(completion.value) == 9);
    assert(vm.frame_count == 0);

    mal_vm_free(&vm);
}

static void test_vm_construct_script_and_native_callees(void) {
    static const c16 prototype_code_units[] = {'p', 'r', 'o', 't', 'o', 't', 'y', 'p', 'e'};
    static const MalStringConstant string_constants[] = {
        {.length = 9, .code_units = prototype_code_units},
    };
    static const i32 construct_arguments[] = {2};
    static const i32 array_arguments[] = {1};
    static const MalInstruction entry_instructions[] = {
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_OBJECT, .as.create_object = {.dst = 1}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 2, .string_index = 0}},
        {.opcode = MAL_OP_STORE_PROPERTY, .as.store_property = {.object = 0, .key = 2, .value = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 1}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 7}},
        // Returns a number, so the constructed this is substituted.
        {.opcode = MAL_OP_CONSTRUCT, .as.construct = {.dst = 3, .callee = 0, .argument_count = 1, .arguments = construct_arguments}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 0}},
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 2}},
        // Returns an object, which wins over the constructed this.
        {.opcode = MAL_OP_CONSTRUCT, .as.construct = {.dst = 3, .callee = 0, .argument_count = 0, .arguments = NULL}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 2}},
        {.opcode = MAL_OP_LOAD_INTRINSIC, .as.load_intrinsic = {.dst = 0, .intrinsic = MAL_INTRINSIC_ARRAY_CONSTRUCTOR}},
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 3}},
        {.opcode = MAL_OP_CONSTRUCT, .as.construct = {.dst = 2, .callee = 0, .argument_count = 1, .arguments = array_arguments}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 3}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalInstruction return_param_instructions[] = {
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalInstruction return_object_instructions[] = {
        {.opcode = MAL_OP_CREATE_OBJECT, .as.create_object = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 4, .captured_count = 0, .instruction_count = 17,
            .instructions = entry_instructions
        },
        {
            .parameter_count = 1, .register_count = 1, .captured_count = 0, .instruction_count = 1,
            .instructions = return_param_instructions
        },
        {
            .parameter_count = 0, .register_count = 1, .captured_count = 0, .instruction_count = 2,
            .instructions = return_object_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 3, .functions = functions, .string_constant_count = 1, .string_constants = string_constants, .global_count = 4
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    // The substituted this uses the callee's prototype property.
    assert(mal_value_is_object(vm.globals[0]));
    assert(mal_object_get_prototype(mal_value_to_object(vm.globals[0])) == mal_value_to_object(vm.globals[1]));
    // The explicitly returned object is an ordinary object literal.
    assert(mal_value_is_object(vm.globals[2]));
    assert(mal_object_get_prototype(mal_value_to_object(vm.globals[2])) == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    // new Array(3) constructs through the native constructor.
    assert(mal_value_is_array_object(vm.globals[3]));
    assert(mal_array_object_length(mal_value_to_array_object(vm.globals[3])) == 3);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_bound_function_resolution_and_calls(void) {
    static const MalInstruction add3_instructions[] = {
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 3, .left = 0, .right = 1, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 4, .left = 3, .right = 2, .op = MAL_BIN_ADD}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 4}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 3, .register_count = 5, .captured_count = 0, .instruction_count = 3,
            .instructions = add3_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1, .functions = functions, .string_constant_count = 0, .string_constants = NULL, .global_count = 0
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);

    MalFunctionObject *target = mal_function_object_new(&vm.heap, NULL, 0);

    MalValue inner_args[] = {mal_value_from_i32(1)};
    MalBoundFunctionObject *inner = mal_bound_function_object_new(
        &vm.heap, NULL, mal_value_from_function_object(target), mal_value_from_i32(42), inner_args, 1
    );
    MalValue outer_args[] = {mal_value_from_i32(2)};
    MalBoundFunctionObject *outer = mal_bound_function_object_new(
        &vm.heap, NULL, mal_value_from_bound_function_object(inner), mal_value_from_i32(99), outer_args, 1
    );

    assert(mal_value_is_callable(mal_value_from_bound_function_object(outer)));
    assert(mal_value_is_object(mal_value_from_bound_function_object(outer)));

    // Calling the nested bound function merges argument prefixes inner-first.
    MalValue call_args[] = {mal_value_from_i32(3)};
    MalCompletion completion = mal_vm_call_value(
        &vm, mal_value_from_bound_function_object(outer), mal_value_new_undefined(), call_args, 1
    );
    assert(completion.kind == MAL_COMPLETION_NORMAL);
    assert(mal_value_to_i32(completion.value) == 6);
    assert(vm.frame_count == 0);

    // The innermost bound this wins for calls; construct ignores it.
    MalBoundResolution resolution = mal_bound_function_object_resolve(
        mal_value_from_bound_function_object(outer), mal_value_new_undefined(), call_args, 1, true
    );
    assert(resolution.callee == mal_value_from_function_object(target));
    assert(mal_value_to_i32(resolution.this_value) == 42);
    assert(resolution.arg_count == 3);
    assert(mal_value_to_i32(resolution.args[0]) == 1);
    assert(mal_value_to_i32(resolution.args[1]) == 2);
    assert(mal_value_to_i32(resolution.args[2]) == 3);
    free(resolution.owned_args);

    resolution = mal_bound_function_object_resolve(
        mal_value_from_bound_function_object(outer), mal_value_new_undefined(), call_args, 1, false
    );
    assert(mal_value_is_undefined(resolution.this_value));
    free(resolution.owned_args);

    mal_vm_free(&vm);
}

static MalValue test_builtin_pair_sum_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    assert(arg_count == 2);
    // The receiver is folded in when it is a number, to observe this-binding.
    i32 base = mal_value_is_int32(this_value) ? mal_value_to_i32(this_value) : 0;
    return mal_value_from_i32(base + mal_value_to_i32(args[0]) + mal_value_to_i32(args[1]));
}

static void test_builtin_function_call_apply_bind_and_to_string(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue function_prototype = vm.intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE];
    MalValue target = test_builtin_native_function(&vm, "pairSum", test_builtin_pair_sum_callback);

    // call(thisArg, ...args)
    MalValue call_args[] = {mal_value_from_i32(100), mal_value_from_i32(1), mal_value_from_i32(2)};
    MalValue call_result = test_builtin_call(&vm, test_builtin_get(&vm, function_prototype, "call"), target, call_args, 3);
    assert(mal_value_to_i32(call_result) == 103);

    // apply(thisArg, argsArray)
    MalArrayObject *apply_array = mal_intrinsic_new_array(&vm, 2);
    mal_object_set((MalObject *) apply_array, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, mal_value_from_i32(4));
    mal_object_set((MalObject *) apply_array, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, mal_value_from_i32(5));
    MalValue apply_args[] = {mal_value_from_i32(100), mal_value_from_array_object(apply_array)};
    MalValue apply_result = test_builtin_call(&vm, test_builtin_get(&vm, function_prototype, "apply"), target, apply_args, 2);
    assert(mal_value_to_i32(apply_result) == 109);

    // bind(thisArg, ...partial) creates a callable bound function.
    MalValue bind_args[] = {mal_value_from_i32(100), mal_value_from_i32(10)};
    MalValue bound = test_builtin_call(&vm, test_builtin_get(&vm, function_prototype, "bind"), target, bind_args, 2);
    assert(mal_value_is_bound_function_object(bound));
    MalValue remaining = mal_value_from_i32(7);
    MalValue bound_result = test_builtin_call(&vm, bound, mal_value_new_undefined(), &remaining, 1);
    assert(mal_value_to_i32(bound_result) == 117);

    // Bound functions inherit %Function.prototype%, so call() works on them.
    MalValue bound_call_args[] = {mal_value_new_undefined(), mal_value_from_i32(8)};
    MalValue bound_call_result = test_builtin_call(&vm, test_builtin_get(&vm, bound, "call"), bound, bound_call_args, 2);
    assert(mal_value_to_i32(bound_call_result) == 118);

    // toString stubs out the body.
    MalValue to_string_result = test_builtin_call(&vm, test_builtin_get(&vm, function_prototype, "toString"), target, NULL, 0);
    assert(test_builtin_value_is_ascii(&vm, to_string_result, "function pairSum() { [native code] }"));

    // The Function constructor throws (no eval support).
    test_builtin_call_throws(&vm, vm.intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR], mal_value_new_undefined(), NULL, 0, "TypeError");

    // call on a non-callable throws.
    MalValue non_callable_args[] = {mal_value_new_undefined()};
    test_builtin_call_throws(&vm, test_builtin_get(&vm, function_prototype, "call"), mal_value_from_i32(5), non_callable_args, 1, "TypeError");

    mal_vm_free(&vm);
}

static void test_vm_function_name_and_length_fast_path(void) {
    static const c16 name_code_units[] = {'n', 'a', 'm', 'e'};
    static const c16 length_code_units[] = {'l', 'e', 'n', 'g', 't', 'h'};
    static const c16 my_fn_code_units[] = {'m', 'y', 'F', 'n'};
    static const MalStringConstant string_constants[] = {
        {.length = 4, .code_units = name_code_units},
        {.length = 6, .code_units = length_code_units},
        {.length = 4, .code_units = my_fn_code_units},
    };
    static const MalInstruction entry_instructions[] = {
        {.opcode = MAL_OP_CREATE_FUNCTION, .as.create_function = {.dst = 0, .function_index = 1}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 0}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 2, .object = 0, .key = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 0}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 1}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 2, .object = 0, .key = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 1}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalInstruction named_instructions[] = {
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 3, .captured_count = 0, .instruction_count = 9,
            .instructions = entry_instructions
        },
        {
            .name_string_index = 2, .parameter_count = 2, .length = 2, .register_count = 2, .captured_count = 0,
            .instruction_count = 1, .instructions = named_instructions
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 2, .functions = functions, .string_constant_count = 3, .string_constants = string_constants, .global_count = 2
    };

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(test_builtin_value_is_ascii(&vm, vm.globals[0], "myFn"));
    assert(mal_value_to_i32(vm.globals[1]) == 2);

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_builtin_object_statics_and_prototype_methods(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue object_constructor = vm.intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR];
    MalPropertyFlags default_flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;

    MalValue object = test_builtin_call(&vm, object_constructor, mal_value_new_undefined(), NULL, 0);
    assert(mal_value_is_object(object));
    assert(mal_object_get_prototype(mal_value_to_object(object)) == mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));

    MalObject *descriptor = mal_intrinsic_new_object(&vm);
    mal_intrinsic_define_data(&vm, descriptor, "value", mal_value_from_i32(7), default_flags);
    mal_intrinsic_define_data(&vm, descriptor, "writable", mal_value_new_boolean(true), default_flags);
    mal_intrinsic_define_data(&vm, descriptor, "enumerable", mal_value_new_boolean(true), default_flags);

    MalValue define_property_args[] = {
        object,
        mal_value_from_string(mal_intrinsic_ascii(&vm, "x")),
        mal_value_from_object(descriptor),
    };
    test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "defineProperty"), mal_value_new_undefined(), define_property_args, 3);
    assert(mal_value_to_i32(test_builtin_get(&vm, object, "x")) == 7);

    MalValue keys = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "keys"), mal_value_new_undefined(), &object, 1);
    assert(mal_array_object_length(mal_value_to_array_object(keys)) == 1);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_index(keys, 0), "x"));

    MalValue values = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "values"), mal_value_new_undefined(), &object, 1);
    assert(mal_value_to_i32(test_builtin_index(values, 0)) == 7);

    MalValue entries = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "entries"), mal_value_new_undefined(), &object, 1);
    MalValue entry = test_builtin_index(entries, 0);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_index(entry, 0), "x"));
    assert(mal_value_to_i32(test_builtin_index(entry, 1)) == 7);

    MalValue assign_target = mal_value_from_object(mal_intrinsic_new_object(&vm));
    MalValue assign_args[] = {assign_target, object};
    test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "assign"), mal_value_new_undefined(), assign_args, 2);
    assert(mal_value_to_i32(test_builtin_get(&vm, assign_target, "x")) == 7);

    MalValue descriptor_result = test_builtin_call(
        &vm,
        test_builtin_get(&vm, object_constructor, "getOwnPropertyDescriptor"),
        mal_value_new_undefined(),
        define_property_args,
        2
    );
    assert(mal_value_to_i32(test_builtin_get(&vm, descriptor_result, "value")) == 7);
    assert(mal_value_to_boolean(test_builtin_get(&vm, descriptor_result, "writable")));
    assert(mal_value_to_boolean(test_builtin_get(&vm, descriptor_result, "enumerable")));
    assert(!mal_value_to_boolean(test_builtin_get(&vm, descriptor_result, "configurable")));

    MalValue has_own_args[] = {object, mal_value_from_string(mal_intrinsic_ascii(&vm, "x"))};
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "hasOwn"), mal_value_new_undefined(), has_own_args, 2)));

    MalValue object_prototype = vm.intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE];
    MalValue has_own_property = test_builtin_get(&vm, object_prototype, "hasOwnProperty");
    MalValue x_key = mal_value_from_string(mal_intrinsic_ascii(&vm, "x"));
    MalValue missing_key = mal_value_from_string(mal_intrinsic_ascii(&vm, "missing"));
    assert(mal_value_to_boolean(test_builtin_call(&vm, has_own_property, object, &x_key, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, has_own_property, object, &missing_key, 1)));

    MalValue created = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "create"), mal_value_new_undefined(), &object, 1);
    MalValue created_prototype = test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "getPrototypeOf"), mal_value_new_undefined(), &created, 1);
    assert(created_prototype == object);

    MalValue is_prototype_of = test_builtin_get(&vm, object_prototype, "isPrototypeOf");
    assert(mal_value_to_boolean(test_builtin_call(&vm, is_prototype_of, object, &created, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, is_prototype_of, created, &object, 1)));

    MalValue nan_args[] = {mal_value_new_nan(), mal_value_new_nan()};
    MalValue mixed_args[] = {mal_value_from_i32(1), mal_value_from_i32(2)};
    MalValue object_is = test_builtin_get(&vm, object_constructor, "is");
    assert(mal_value_to_boolean(test_builtin_call(&vm, object_is, mal_value_new_undefined(), nan_args, 2)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, object_is, mal_value_new_undefined(), mixed_args, 2)));

    MalValue to_string = test_builtin_get(&vm, object_prototype, "toString");
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, object, NULL, 0), "[object Object]"));
    MalValue empty_array = mal_value_from_array_object(mal_intrinsic_new_array(&vm, 0));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, to_string, empty_array, NULL, 0), "[object Array]"));

    MalValue is_frozen = test_builtin_get(&vm, object_constructor, "isFrozen");
    assert(!mal_value_to_boolean(test_builtin_call(&vm, is_frozen, mal_value_new_undefined(), &object, 1)));
    test_builtin_call(&vm, test_builtin_get(&vm, object_constructor, "freeze"), mal_value_new_undefined(), &object, 1);
    assert(mal_value_to_boolean(test_builtin_call(&vm, is_frozen, mal_value_new_undefined(), &object, 1)));
    assert(!mal_object_is_extensible(mal_value_to_object(object)));
    assert(!mal_object_set(mal_value_to_object(object), mal_intrinsic_string_key(&vm, "x"), mal_value_from_i32(9)));
    assert(mal_value_to_i32(test_builtin_get(&vm, object, "x")) == 7);

    mal_vm_free(&vm);
}

static void test_builtin_array_constructor_and_prototype_methods(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue array_constructor = vm.intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR];
    MalValue array_prototype = vm.intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
    MalValue one_two_three[] = {mal_value_from_i32(1), mal_value_from_i32(2), mal_value_from_i32(3)};

    MalValue array = test_builtin_call(&vm, array_constructor, mal_value_new_undefined(), one_two_three, 3);
    assert(mal_value_is_array_object(array));
    assert(mal_array_object_length(mal_value_to_array_object(array)) == 3);
    assert(mal_value_to_i32(test_builtin_index(array, 2)) == 3);

    MalValue sized_arg = mal_value_from_i32(5);
    MalValue sized = test_builtin_call(&vm, array_constructor, mal_value_new_undefined(), &sized_arg, 1);
    assert(mal_array_object_length(mal_value_to_array_object(sized)) == 5);
    assert(mal_value_is_undefined(test_builtin_index(sized, 0)));

    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "isArray"), mal_value_new_undefined(), &array, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "isArray"), mal_value_new_undefined(), &sized_arg, 1)));

    MalValue of_result = test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "of"), mal_value_new_undefined(), one_two_three, 3);
    assert(mal_array_object_length(mal_value_to_array_object(of_result)) == 3);

    MalValue from_result = test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "from"), mal_value_new_undefined(), &array, 1);
    assert(mal_array_object_length(mal_value_to_array_object(from_result)) == 3);
    assert(mal_value_to_i32(test_builtin_index(from_result, 1)) == 2);

    MalValue double_value = test_builtin_native_function(&vm, "double", test_builtin_double_callback);
    MalValue mapped = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "map"), array, &double_value, 1);
    assert(mal_array_object_length(mal_value_to_array_object(mapped)) == 3);
    assert(mal_value_to_i32(test_builtin_index(mapped, 0)) == 2);
    assert(mal_value_to_i32(test_builtin_index(mapped, 2)) == 6);

    // Holes are skipped and preserved by map.
    MalValue sparse_mapped = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "map"), sized, &double_value, 1);
    assert(mal_array_object_length(mal_value_to_array_object(sparse_mapped)) == 5);
    assert(!mal_object_get_own(mal_value_to_object(sparse_mapped), (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}).present);

    MalValue is_even_value = test_builtin_native_function(&vm, "isEven", test_builtin_is_even_callback);
    MalValue filtered = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "filter"), array, &is_even_value, 1);
    assert(mal_array_object_length(mal_value_to_array_object(filtered)) == 1);
    assert(mal_value_to_i32(test_builtin_index(filtered, 0)) == 2);

    MalValue reduce_args[] = {test_builtin_native_function(&vm, "sum", test_builtin_sum_callback), mal_value_from_i32(10)};
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "reduce"), array, reduce_args, 1)) == 6);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "reduce"), array, reduce_args, 2)) == 16);

    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "find"), array, &is_even_value, 1)) == 2);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "findIndex"), array, &is_even_value, 1)) == 1);
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "some"), array, &is_even_value, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "every"), array, &is_even_value, 1)));

    test_builtin_for_each_sum = 0;
    MalValue for_each_value = test_builtin_native_function(&vm, "forEachSum", test_builtin_for_each_callback);
    test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "forEach"), array, &for_each_value, 1);
    assert(test_builtin_for_each_sum == 6);

    MalValue two = mal_value_from_i32(2);
    MalValue nine = mal_value_from_i32(9);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "indexOf"), array, &two, 1)) == 1);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "indexOf"), array, &nine, 1)) == -1);
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "includes"), array, &two, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "includes"), array, &nine, 1)));

    MalValue repeated_args[] = {mal_value_from_i32(1), mal_value_from_i32(2), mal_value_from_i32(1)};
    MalValue repeated = test_builtin_call(&vm, test_builtin_get(&vm, array_constructor, "of"), mal_value_new_undefined(), repeated_args, 3);
    MalValue one = mal_value_from_i32(1);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "lastIndexOf"), repeated, &one, 1)) == 2);

    MalValue push_args[] = {mal_value_from_i32(4), mal_value_from_i32(5)};
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "push"), array, push_args, 2)) == 5);
    assert(mal_array_object_length(mal_value_to_array_object(array)) == 5);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "pop"), array, NULL, 0)) == 5);
    assert(mal_array_object_length(mal_value_to_array_object(array)) == 4);

    MalValue slice_args[] = {mal_value_from_i32(1), mal_value_from_i32(3)};
    MalValue sliced = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "slice"), array, slice_args, 2);
    assert(mal_array_object_length(mal_value_to_array_object(sliced)) == 2);
    assert(mal_value_to_i32(test_builtin_index(sliced, 0)) == 2);
    assert(mal_value_to_i32(test_builtin_index(sliced, 1)) == 3);

    MalValue concatenated = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "concat"), array, &repeated, 1);
    assert(mal_array_object_length(mal_value_to_array_object(concatenated)) == 7);
    assert(mal_value_to_i32(test_builtin_index(concatenated, 4)) == 1);

    MalValue separator = mal_value_from_string(mal_intrinsic_ascii(&vm, "-"));
    MalValue joined = test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "join"), of_result, &separator, 1);
    assert(test_builtin_value_is_ascii(&vm, joined, "1-2-3"));

    test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "reverse"), of_result, NULL, 0);
    assert(mal_value_to_i32(test_builtin_index(of_result, 0)) == 3);
    assert(mal_value_to_i32(test_builtin_index(of_result, 2)) == 1);

    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "shift"), of_result, NULL, 0)) == 3);
    assert(mal_array_object_length(mal_value_to_array_object(of_result)) == 2);
    assert(mal_value_to_i32(test_builtin_index(of_result, 0)) == 2);

    MalValue seven = mal_value_from_i32(7);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "unshift"), of_result, &seven, 1)) == 3);
    assert(mal_value_to_i32(test_builtin_index(of_result, 0)) == 7);

    MalValue fill_args[] = {mal_value_from_i32(0), mal_value_from_i32(1), mal_value_from_i32(3)};
    test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "fill"), of_result, fill_args, 3);
    assert(mal_value_to_i32(test_builtin_index(of_result, 0)) == 7);
    assert(mal_value_to_i32(test_builtin_index(of_result, 1)) == 0);
    assert(mal_value_to_i32(test_builtin_index(of_result, 2)) == 0);

    MalValue negative_one = mal_value_from_i32(-1);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, array_prototype, "at"), array, &negative_one, 1)) == 4);

    mal_vm_free(&vm);
}

static MalValue test_builtin_ascii(MalVm *vm, const byte *value) {
    return mal_value_from_string(mal_intrinsic_ascii(vm, value));
}

static void test_builtin_string_constructor_and_prototype_methods(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue string_prototype = vm.intrinsics[MAL_INTRINSIC_STRING_PROTOTYPE];
    MalValue hello = test_builtin_ascii(&vm, "Hello World");

    // String(x) coerces to a primitive string.
    MalValue five = mal_value_from_i32(5);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_STRING_CONSTRUCTOR], mal_value_new_undefined(), &five, 1), "5"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_STRING_CONSTRUCTOR], mal_value_new_undefined(), NULL, 0), ""));

    MalValue char_codes[] = {mal_value_from_i32(72), mal_value_from_i32(105)};
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, vm.intrinsics[MAL_INTRINSIC_STRING_CONSTRUCTOR], "fromCharCode"), mal_value_new_undefined(), char_codes, 2), "Hi"));

    MalValue four = mal_value_from_i32(4);
    MalValue negative_one = mal_value_from_i32(-1);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "charAt"), hello, &four, 1), "o"));
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "charCodeAt"), hello, &four, 1)) == 'o');
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "at"), hello, &negative_one, 1), "d"));

    MalValue world = test_builtin_ascii(&vm, "World");
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "indexOf"), hello, &world, 1)) == 6);
    MalValue l_string = test_builtin_ascii(&vm, "l");
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "lastIndexOf"), hello, &l_string, 1)) == 9);
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "includes"), hello, &world, 1)));
    MalValue hello_prefix = test_builtin_ascii(&vm, "Hello");
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "startsWith"), hello, &hello_prefix, 1)));
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "endsWith"), hello, &world, 1)));

    MalValue slice_args[] = {mal_value_from_i32(-5)};
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "slice"), hello, slice_args, 1), "World"));
    MalValue substring_args[] = {mal_value_from_i32(5), mal_value_from_i32(0)};
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "substring"), hello, substring_args, 2), "Hello"));

    MalValue exclaim = test_builtin_ascii(&vm, "!");
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "concat"), hello, &exclaim, 1), "Hello World!"));

    MalValue ab = test_builtin_ascii(&vm, "ab");
    MalValue three = mal_value_from_i32(3);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "repeat"), ab, &three, 1), "ababab"));
    MalValue negative_count = mal_value_from_i32(-1);
    test_builtin_call_throws(&vm, test_builtin_get(&vm, string_prototype, "repeat"), ab, &negative_count, 1, "RangeError");

    MalValue padded = test_builtin_ascii(&vm, "  pad  ");
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "trim"), padded, NULL, 0), "pad"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "trimStart"), padded, NULL, 0), "pad  "));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "trimEnd"), padded, NULL, 0), "  pad"));

    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "toUpperCase"), hello, NULL, 0), "HELLO WORLD"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "toLowerCase"), hello, NULL, 0), "hello world"));

    MalValue csv = test_builtin_ascii(&vm, "a,b,c");
    MalValue comma = test_builtin_ascii(&vm, ",");
    MalValue split_result = test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "split"), csv, &comma, 1);
    assert(mal_array_object_length(mal_value_to_array_object(split_result)) == 3);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_index(split_result, 1), "b"));

    MalValue replace_args[] = {l_string, test_builtin_ascii(&vm, "L")};
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "replace"), hello, replace_args, 2), "HeLlo World"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "replaceAll"), hello, replace_args, 2), "HeLLo WorLd"));

    MalValue pad_args[] = {mal_value_from_i32(5), test_builtin_ascii(&vm, "0")};
    MalValue forty_two = test_builtin_ascii(&vm, "42");
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "padStart"), forty_two, pad_args, 2), "00042"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, string_prototype, "padEnd"), forty_two, pad_args, 2), "42000"));

    mal_vm_free(&vm);
}

static void test_builtin_number_boolean_and_global_functions(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue number_constructor = vm.intrinsics[MAL_INTRINSIC_NUMBER_CONSTRUCTOR];
    MalValue number_prototype = vm.intrinsics[MAL_INTRINSIC_NUMBER_PROTOTYPE];

    MalValue forty_two_string = test_builtin_ascii(&vm, "42");
    assert(mal_value_to_i32(test_builtin_call(&vm, number_constructor, mal_value_new_undefined(), &forty_two_string, 1)) == 42);
    assert(mal_value_to_i32(test_builtin_call(&vm, number_constructor, mal_value_new_undefined(), NULL, 0)) == 0);

    MalValue three = mal_value_from_i32(3);
    MalValue three_point_five = mal_value_from_f64(3.5);
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, number_constructor, "isInteger"), mal_value_new_undefined(), &three, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, number_constructor, "isInteger"), mal_value_new_undefined(), &three_point_five, 1)));

    MalValue nan_value = mal_value_new_nan();
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, number_constructor, "isNaN"), mal_value_new_undefined(), &nan_value, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, number_constructor, "isNaN"), mal_value_new_undefined(), &three, 1)));
    assert(mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, number_constructor, "isFinite"), mal_value_new_undefined(), &three, 1)));

    // parseInt handles radix, hex prefixes and trailing garbage.
    MalValue parse_int = vm.intrinsics[MAL_INTRINSIC_PARSE_INT];
    MalValue int_args[] = {test_builtin_ascii(&vm, "  -42px")};
    assert(mal_value_to_i32(test_builtin_call(&vm, parse_int, mal_value_new_undefined(), int_args, 1)) == -42);
    MalValue hex_args[] = {test_builtin_ascii(&vm, "0xff")};
    assert(mal_value_to_i32(test_builtin_call(&vm, parse_int, mal_value_new_undefined(), hex_args, 1)) == 255);
    MalValue binary_args[] = {test_builtin_ascii(&vm, "101"), mal_value_from_i32(2)};
    assert(mal_value_to_i32(test_builtin_call(&vm, parse_int, mal_value_new_undefined(), binary_args, 2)) == 5);
    MalValue garbage_args[] = {test_builtin_ascii(&vm, "nope")};
    assert(mal_value_is_nan(test_builtin_call(&vm, parse_int, mal_value_new_undefined(), garbage_args, 1)));

    MalValue parse_float = vm.intrinsics[MAL_INTRINSIC_PARSE_FLOAT];
    MalValue float_args[] = {test_builtin_ascii(&vm, "3.5rem")};
    assert(mal_value_to_f64(test_builtin_call(&vm, parse_float, mal_value_new_undefined(), float_args, 1)) == 3.5);

    // Global isNaN coerces, Number.isNaN does not.
    MalValue nan_string = test_builtin_ascii(&vm, "not a number");
    assert(mal_value_to_boolean(test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_IS_NAN], mal_value_new_undefined(), &nan_string, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, test_builtin_get(&vm, number_constructor, "isNaN"), mal_value_new_undefined(), &nan_string, 1)));
    assert(mal_value_to_boolean(test_builtin_call(&vm, vm.intrinsics[MAL_INTRINSIC_IS_FINITE], mal_value_new_undefined(), &forty_two_string, 1)));

    assert(mal_value_to_f64(test_builtin_get(&vm, number_constructor, "MAX_SAFE_INTEGER")) == 9007199254740991.0);

    MalValue two_digits = mal_value_from_i32(2);
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, number_prototype, "toFixed"), three_point_five, &two_digits, 1), "3.50"));
    MalValue bad_digits = mal_value_from_i32(200);
    test_builtin_call_throws(&vm, test_builtin_get(&vm, number_prototype, "toFixed"), three, &bad_digits, 1, "RangeError");

    MalValue boolean_constructor = vm.intrinsics[MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR];
    MalValue boolean_prototype = vm.intrinsics[MAL_INTRINSIC_BOOLEAN_PROTOTYPE];
    MalValue zero = mal_value_from_i32(0);
    assert(mal_value_to_boolean(test_builtin_call(&vm, boolean_constructor, mal_value_new_undefined(), &three, 1)));
    assert(!mal_value_to_boolean(test_builtin_call(&vm, boolean_constructor, mal_value_new_undefined(), &zero, 1)));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_call(&vm, test_builtin_get(&vm, boolean_prototype, "toString"), mal_value_new_boolean(true), NULL, 0), "true"));

    mal_vm_free(&vm);
}

static void test_vm_primitive_dispatch_and_unary_ops(void) {
    static const c16 length_units[] = {'l', 'e', 'n', 'g', 't', 'h'};
    static const c16 abc_units[] = {'a', 'b', 'c'};
    static const c16 upper_units[] = {'t', 'o', 'U', 'p', 'p', 'e', 'r', 'C', 'a', 's', 'e'};
    static const MalStringConstant string_constants[] = {
        {.length = 6, .code_units = length_units},
        {.length = 3, .code_units = abc_units},
        {.length = 11, .code_units = upper_units},
    };
    static const i32 no_arguments[] = {0};
    static const MalInstruction entry_instructions[] = {
        // "abc".length
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 0, .string_index = 1}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 0}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 2, .object = 0, .key = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 0}},
        // "abc"[1]
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 1}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 2, .object = 0, .key = 1}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 2, .index = 1}},
        // "abc".toUpperCase() through the prototype dispatch
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 2}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 2, .object = 0, .key = 1}},
        {.opcode = MAL_OP_CALL, .as.call = {.dst = 3, .callee = 2, .this_value = 0, .argument_count = 0, .arguments = NULL}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 2}},
        // Unary operators
        {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 7}},
        {.opcode = MAL_OP_UNARY, .as.unary = {.dst = 1, .src = 0, .op = MAL_UNARY_NEGATE}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 3}},
        {.opcode = MAL_OP_UNARY, .as.unary = {.dst = 1, .src = 0, .op = MAL_UNARY_NOT}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 4}},
        {.opcode = MAL_OP_UNARY, .as.unary = {.dst = 1, .src = 0, .op = MAL_UNARY_BIT_NOT}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 5}},
        {.opcode = MAL_OP_UNARY, .as.unary = {.dst = 1, .src = 0, .op = MAL_UNARY_TYPEOF}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 1, .index = 6}},
        // Property loads on undefined throw a TypeError; catch it.
        {.opcode = MAL_OP_TRY_BEGIN},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_CREATE_STRING, .as.create_string = {.dst = 1, .string_index = 0}},
        {.opcode = MAL_OP_LOAD_PROPERTY, .as.load_property = {.dst = 2, .object = 0, .key = 1}},
        {.opcode = MAL_OP_TRY_END},
        {.opcode = MAL_OP_JUMP, .as.jump = {.target_ip = 27}},
        {.opcode = MAL_OP_CATCH, .as.caught = {.dst = 3}},
        {.opcode = MAL_OP_STORE_GLOBAL, .as.store_global = {.src = 3, .index = 7}},
        {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 0}},
        {.opcode = MAL_OP_RETURN, .as.ret = {.value = 0}},
    };
    static const MalExceptionHandler handlers[] = {
        {.start_ip = 20, .end_ip = 24, .handler_ip = 26},
    };
    static const MalFunction functions[] = {
        {
            .parameter_count = 0, .register_count = 4, .captured_count = 0, .instruction_count = 30,
            .instructions = entry_instructions, .handler_count = 1, .handlers = handlers
        },
    };
    static const MalVmDefinition definition = {
        .function_count = 1, .functions = functions, .string_constant_count = 3, .string_constants = string_constants, .global_count = 8
    };
    (void) no_arguments;

    MalVm vm;
    mal_vm_init(&vm, &definition);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);

    mal_vm_run(&vm, callable);

    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    assert(mal_value_to_i32(vm.globals[0]) == 3);
    assert(test_builtin_value_is_ascii(&vm, vm.globals[1], "b"));
    assert(test_builtin_value_is_ascii(&vm, vm.globals[2], "ABC"));
    assert(mal_value_to_i32(vm.globals[3]) == -7);
    assert(!mal_value_to_boolean(vm.globals[4]));
    assert(mal_value_to_i32(vm.globals[5]) == -8);
    assert(test_builtin_value_is_ascii(&vm, vm.globals[6], "number"));
    assert(test_builtin_value_is_ascii(&vm, test_builtin_get(&vm, vm.globals[7], "name"), "TypeError"));

    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
}

static void test_builtin_math_json_console_and_global_this(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalValue math = vm.intrinsics[MAL_INTRINSIC_MATH];
    MalValue minus_five = mal_value_from_i32(-5);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, math, "abs"), math, &minus_five, 1)) == 5);

    MalValue max_args[] = {mal_value_from_i32(1), mal_value_from_i32(7), mal_value_from_i32(3)};
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, math, "max"), math, max_args, 3)) == 7);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, math, "min"), math, max_args, 3)) == 1);

    MalValue pow_args[] = {mal_value_from_i32(2), mal_value_from_i32(8)};
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, math, "pow"), math, pow_args, 2)) == 256);

    MalValue half = mal_value_from_f64(2.5);
    assert(mal_value_to_i32(test_builtin_call(&vm, test_builtin_get(&vm, math, "round"), math, &half, 1)) == 3);

    f64 pi = mal_value_to_f64(test_builtin_get(&vm, math, "PI"));
    assert(pi > 3.14 && pi < 3.15);

    MalValue random = test_builtin_call(&vm, test_builtin_get(&vm, math, "random"), math, NULL, 0);
    f64 random_value = mal_value_is_f64(random) ? mal_value_to_f64(random) : (f64) mal_value_to_i32(random);
    assert(random_value >= 0 && random_value < 1);

    // JSON round trip.
    MalValue json = vm.intrinsics[MAL_INTRINSIC_JSON];
    MalObject *payload = mal_intrinsic_new_object(&vm);
    mal_intrinsic_define_data(&vm, payload, "a", mal_value_from_i32(1), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    MalArrayObject *list = mal_intrinsic_new_array(&vm, 2);
    mal_object_set((MalObject *) list, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, mal_value_new_boolean(true));
    mal_object_set((MalObject *) list, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, mal_value_new_null());
    mal_intrinsic_define_data(&vm, payload, "b", mal_value_from_array_object(list), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);

    MalValue payload_value = mal_value_from_object(payload);
    MalValue stringified = test_builtin_call(&vm, test_builtin_get(&vm, json, "stringify"), json, &payload_value, 1);
    assert(test_builtin_value_is_ascii(&vm, stringified, "{\"a\":1,\"b\":[true,null]}"));

    MalValue parsed = test_builtin_call(&vm, test_builtin_get(&vm, json, "parse"), json, &stringified, 1);
    assert(mal_value_to_i32(test_builtin_get(&vm, parsed, "a")) == 1);
    assert(mal_array_object_length(mal_value_to_array_object(test_builtin_get(&vm, parsed, "b"))) == 2);
    assert(mal_value_is_null(test_builtin_index(test_builtin_get(&vm, parsed, "b"), 1)));

    MalValue escaped = test_builtin_ascii(&vm, "line\nbreak \"quoted\"");
    MalValue escaped_json = test_builtin_call(&vm, test_builtin_get(&vm, json, "stringify"), json, &escaped, 1);
    assert(test_builtin_value_is_ascii(&vm, escaped_json, "\"line\\nbreak \\\"quoted\\\"\""));

    MalValue bad_json = test_builtin_ascii(&vm, "{\"a\":");
    test_builtin_call_throws(&vm, test_builtin_get(&vm, json, "parse"), json, &bad_json, 1, "SyntaxError");

    // globalThis wires the intrinsics together.
    MalValue global_this = vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    assert(test_builtin_get(&vm, global_this, "Math") == math);
    assert(test_builtin_get(&vm, global_this, "globalThis") == global_this);
    assert(mal_value_is_nan(test_builtin_get(&vm, global_this, "NaN")));

    // console.log returns undefined and must not crash.
    MalValue log_args[] = {test_builtin_ascii(&vm, "console test:"), mal_value_from_i32(42), payload_value};
    assert(mal_value_is_undefined(test_builtin_call(&vm, test_builtin_get(&vm, vm.intrinsics[MAL_INTRINSIC_CONSOLE], "log"), vm.intrinsics[MAL_INTRINSIC_CONSOLE], log_args, 3)));

    mal_vm_free(&vm);
}

int main(void) {
    test_binary_value_ops_handle_int32_arithmetic();
    test_binary_value_ops_handle_bitwise_operations();
    test_string_values_use_utf16_code_unit_length();
    test_string_value_ops_concatenate_and_convert_values();
    test_string_value_ops_compare_strings_and_converted_numbers();
    test_vm_binary_op_dispatches_all_binary_operators();
    test_vm_call_frame_returns_to_caller();
    test_vm_call_frame_fills_missing_parameters_with_undefined();
    test_vm_create_string_uses_utf16_string_constants();
    test_vm_object_property_ops_create_read_and_write_properties();
    test_vm_array_property_ops_manage_indices_and_length();
    test_object_new_initializes_base_state();
    test_string_new_copy_owns_byte_storage();
    test_string_new_external_borrows_code_unit_storage();
    test_symbol_new_stores_optional_description();
    test_table_uses_structural_string_keys_and_identity_symbol_keys();
    test_property_define_lookup_and_entry_accessors();
    test_property_set_value_creates_default_data_descriptor();
    test_property_iter_storage_order_yields_insertion_order();
    test_property_iter_own_property_order_groups_index_string_and_symbol_keys();
    test_property_iter_enumerable_own_property_order_skips_non_enumerable_entries();
    test_object_ops_manage_extensibility_and_prototype_state();
    test_object_define_own_rejects_new_properties_on_non_extensible_objects();
    test_object_define_own_rejects_incompatible_non_configurable_changes();
    test_object_delete_own_respects_configurable_flag();
    test_object_resolve_property_walks_prototype_chain();
    test_object_set_updates_writable_own_properties_and_creates_new_properties();
    test_object_set_rejects_non_writable_data_properties();
    test_function_object_new_initializes_script_function_state();
    test_native_function_object_new_initializes_native_function_state();
    test_array_object_new_initializes_array_state();
    test_builtin_object_statics_and_prototype_methods();
    test_builtin_array_constructor_and_prototype_methods();
    test_builtin_error_constructors_and_to_string();
    test_vm_throw_error_sets_completion_and_builtins_throw();
    test_vm_try_catch_unwinds_to_handler();
    test_vm_nested_try_picks_innermost_handler_and_rethrows();
    test_vm_throw_unwinds_across_call_frames();
    test_vm_uncaught_throw_propagates_through_call_value();
    test_vm_construct_script_and_native_callees();
    test_bound_function_resolution_and_calls();
    test_builtin_function_call_apply_bind_and_to_string();
    test_vm_function_name_and_length_fast_path();
    test_builtin_string_constructor_and_prototype_methods();
    test_builtin_number_boolean_and_global_functions();
    test_vm_primitive_dispatch_and_unary_ops();
    test_builtin_math_json_console_and_global_this();

    MalVm vm;

    mal_vm_init(&vm, &mal_vm_definition);
    auto callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    // tmp2.js checks its own result and throws on a mismatch.
    assert(vm.completion.kind == MAL_COMPLETION_NORMAL);
    mal_vm_free_callable(callable);
    mal_vm_free(&vm);

    printf("\n");

    return 0;
}
