package com.personalaios.glasses

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.core.view.doOnPreDraw

/** Approved 640×480 optical composition: two subtitle lines, no panel, centre/lower view stays clear. */
class CompanionReplyHud(context: Context, line: CompanionReplyLine, portrait: AvatarPortrait?, progress: ActivityLine?) : FrameLayout(context) {
    val subtitle: TextView
    init {
        id = R.id.companion_reply
        layoutParams = LayoutParams(640, 128)
        alpha = line.alpha
        fun place(view: android.view.View, x: Int, y: Int, width: Int, height: Int) =
            addView(view, LayoutParams(width, height).apply { leftMargin = x; topMargin = y })
        fun label(text: String, size: Float, color: Int, bold: Boolean = false) = TextView(context).apply {
            this.text = text; setTextColor(color); setTextSize(TypedValue.COMPLEX_UNIT_PX, size)
            typeface = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT; includeFontPadding = false
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        val blue = Color.rgb(91, 134, 255); val secondary = Color.rgb(166, 174, 192)
        if (line.speaking) place(android.view.View(context).apply { background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL; setColor(Color.TRANSPARENT); setStroke(2, blue)
        } }, 23, 15, 46, 46)
        place(ImageView(context).apply {
            if (portrait == null) { setImageResource(R.drawable.yimi_companion_face); scaleType = ImageView.ScaleType.CENTER_CROP }
            else { setImageBitmap(portrait.bitmap); scaleType = ImageView.ScaleType.MATRIX
                doOnPreDraw {
                    val scale = maxOf(36f / portrait.bitmap.width, 36f / portrait.bitmap.height)
                    imageMatrix = android.graphics.Matrix().apply {
                        setScale(scale, scale)
                        postTranslate((18f - portrait.bitmap.width * scale * portrait.profile.x.toFloat()).coerceIn(36f - portrait.bitmap.width * scale, 0f),
                            (18f - portrait.bitmap.height * scale * portrait.profile.y.toFloat()).coerceIn(36f - portrait.bitmap.height * scale, 0f))
                    }
                }
            }
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.BLACK) }; clipToOutline = true
            foreground = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.TRANSPARENT); setStroke(2, blue) }
        }, 28, 20, 36, 36)
        val quiet = line.text.isEmpty()
        place(label(if (line.speaking) "依米 · 在说话" else "依米", if (quiet) 18f else 16f, if (quiet) blue else secondary, quiet), 80, 17, 400, 22)
        if (quiet) place(label("在呢", 16f, secondary), 80, 43, 528, 22)
        place(android.view.View(context).apply { background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL; setColor(Color.rgb(63, 203, 132))
        } }, 536, 22, 8, 8)
        place(label("随身开", 16f, secondary), 552, 17, 80, 20)
        subtitle = label(line.text, 20f, Color.rgb(236, 239, 246), true).apply { maxLines = 2; setLineSpacing(5f, 1f) }
        place(subtitle, 80, 43, 528, 54)
        val detail = listOfNotNull(progress?.title, progress?.text, progress?.progress?.label).joinToString(" · ")
        if (detail.isNotEmpty()) place(label(detail, 16f, secondary).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }, 80, 103, 528, 22)
        contentDescription = listOf(line.text, detail).filter { it.isNotEmpty() }.joinToString(" ")
    }
    fun textFits(): Boolean = subtitle.layout?.let { layout ->
        layout.lineCount in 1..2 && layout.height <= subtitle.height &&
            layout.getLineEnd(layout.lineCount - 1) == subtitle.text.length &&
            (0 until layout.lineCount).all { layout.getEllipsisCount(it) == 0 }
    } == true
}
